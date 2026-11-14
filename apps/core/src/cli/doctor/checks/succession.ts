import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

const DAY_MS = 86_400_000
const GRACE_MS = 7 * DAY_MS
const OWNER_ABSENCE = 'owner-absence'

const isoOf = (ms: number): string => new Date(ms).toISOString()

interface ValueRow {
  value: string
}
interface StateRow {
  state: string
  grace_started_at: number | null
  claimable_at: number | null
}

/** A JSON settings value, or undefined when the key is absent or not valid JSON. */
function settingOf(
  sqlite: ReturnType<typeof openReadOnlyDatabase>,
  key: string,
): unknown | undefined {
  const row = sqlite.query<ValueRow, [string]>('SELECT value FROM settings WHERE key = ?').get(key)
  if (row === null || row === undefined) return undefined
  try {
    return JSON.parse(row.value) as unknown
  } catch {
    return undefined
  }
}

/**
 * The succession line (docs/specs/succession.md, "CLI and TUI"): a `!` when no heir is set (nobody can take over Keith if
 * the owner is gone), a `!` when the owner-absence protocol is missing or switched off, else a `✓` with the heir and the
 * window, or the day a grace or a claim runs to. Read only, like the other checks: nothing is written.
 */
export const successionCheck: DoctorCheck = (ctx) => {
  if (ctx.checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const sqlite = openReadOnlyDatabase(ctx.config.dbFile)
  try {
    const heir = settingOf(sqlite, 'succession.heir')
    if (typeof heir !== 'string' || heir === '') {
      return [
        {
          level: 'warn',
          name: 'succession',
          hint: 'no heir: if you are gone nobody can take over Keith',
        },
      ]
    }
    const heirName =
      sqlite.query<{ name: string }, [string]>('SELECT name FROM people WHERE id = ?').get(heir)
        ?.name ?? heir
    const windowValue = settingOf(sqlite, 'succession.windowDays')
    const windowDays = typeof windowValue === 'number' ? windowValue : 14

    const protocol = sqlite
      .query<{ enabled: number }, [string]>(
        `SELECT enabled FROM protocols WHERE owner = 'keith' AND built_in = ?`,
      )
      .get(OWNER_ABSENCE)
    if (protocol === null || protocol === undefined || protocol.enabled !== 1) {
      const why = protocol === null || protocol === undefined ? 'missing' : 'switched off'
      return [
        {
          level: 'warn',
          name: 'succession',
          hint: `heir ${heirName} is named, but the owner-absence protocol is ${why}`,
        },
      ]
    }

    const run = sqlite
      .query<StateRow, []>(
        'SELECT state, grace_started_at, claimable_at FROM succession_state WHERE id = 1',
      )
      .get()
    if (run?.state === 'grace' && run.grace_started_at !== null) {
      return [
        {
          level: 'ok',
          name: 'succession',
          hint: `grace until ${isoOf(run.grace_started_at + GRACE_MS)} (heir: ${heirName})`,
        },
      ]
    }
    if (run?.state === 'claimable' && run.claimable_at !== null) {
      return [
        {
          level: 'ok',
          name: 'succession',
          hint: `claimable since ${isoOf(run.claimable_at)} (heir: ${heirName})`,
        },
      ]
    }
    return [
      {
        level: 'ok',
        name: 'succession',
        hint: `armed (heir: ${heirName}, window ${windowDays} days)`,
      } satisfies Check,
    ]
  } finally {
    sqlite.close()
  }
}
