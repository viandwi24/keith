import { APPROVAL_STALE, REMINDER_MISSED } from '../../../modules/hypothalamus/index.ts'
import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

const BUILT_INS = [APPROVAL_STALE, REMINDER_MISSED] as const

interface BuiltInRow {
  enabled: number
}

/**
 * The protocol engine (docs/specs/hypothalamus.md, "Built-ins"): each built-in of the self layer must exist and be switched
 * on, else a `!` line names it (the core seeds a missing one at its next boot). The line counts the enabled protocols.
 * Read only, like the other checks: the database opens read only and nothing is written.
 */
export const protocolsCheck: DoctorCheck = (ctx) => {
  if (ctx.checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const sqlite = openReadOnlyDatabase(ctx.config.dbFile)
  try {
    const problems: string[] = []
    for (const name of BUILT_INS) {
      const row = sqlite
        .query<BuiltInRow, [string]>(
          `SELECT enabled FROM protocols WHERE owner = 'keith' AND built_in = ?`,
        )
        .get(name)
      if (row === null || row === undefined) {
        problems.push(`built-in ${name} is missing: the core seeds it at its next boot`)
      } else if (row.enabled !== 1) {
        problems.push(`built-in ${name} is switched off`)
      }
    }
    const enabled =
      sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM protocols WHERE enabled = 1').get()
        ?.n ?? 0
    const count = `${enabled} enabled ${enabled === 1 ? 'protocol' : 'protocols'}`
    const line: Check =
      problems.length === 0
        ? { level: 'ok', name: 'protocols', hint: `${count}, both built-ins on` }
        : { level: 'warn', name: 'protocols', hint: `${count}; ${problems.join('; ')}` }
    return [line]
  } finally {
    sqlite.close()
  }
}
