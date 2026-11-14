import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateDatabase,
  openDatabase,
  protocolsRepo,
  type Sqlite,
  settingsRepo,
  successionRepo,
} from '@keith/db'
import type { Check, DoctorCtx } from '../types.ts'
import { successionCheck } from './succession.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 10, 9)
const DAY = 86_400_000

interface Setup {
  heir?: string
  name?: string
  window?: number
  /** The owner-absence protocol row: its enabled flag, or no row at all. */
  protocol?: boolean | 'missing'
  grace?: boolean
}

/** A migrated database with the succession settings and protocol described; the check opens it read only. */
function ctxWith(setup: Setup): DoctorCtx {
  const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-succession-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  const sqlite: Sqlite = openDatabase(dbFile)
  migrateDatabase(sqlite)
  if (setup.name !== undefined)
    sqlite.run(
      "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES ('ana', ?, 'member', 1, 'ana', 'active', 1)",
      [setup.name],
    )
  const settings = settingsRepo(sqlite)
  if (setup.heir !== undefined) settings.set('succession.heir', setup.heir)
  if (setup.window !== undefined) settings.set('succession.windowDays', setup.window)
  if (setup.protocol !== undefined && setup.protocol !== 'missing')
    protocolsRepo(sqlite).create(
      {
        id: 'proto_owner_absence',
        owner: 'keith',
        name: 'Owner absence',
        builtIn: 'owner-absence',
        definition: '{}',
        savedBy: 'owner',
        enabled: setup.protocol,
      },
      NOW,
    )
  if (setup.grace === true) {
    const repo = successionRepo(sqlite)
    repo.start({ runId: 'run_doctor', heir: 'ana', startedAt: NOW, lastSignAt: null }, NOW)
    repo.move('check-in', 'grace', NOW, { graceStartedAt: NOW })
  }
  sqlite.close()
  return {
    config: { dbFile },
    checks: [{ level: 'ok', name: 'database', hint: 'migrated' }],
  } as unknown as DoctorCtx
}

const linesOf = (ctx: DoctorCtx): Check[] => successionCheck(ctx) as Check[]

describe('doctor: succession', () => {
  test('no heir: a note that nobody can take over Keith', () => {
    expect(linesOf(ctxWith({}))).toEqual([
      {
        level: 'warn',
        name: 'succession',
        hint: 'no heir: if you are gone nobody can take over Keith',
      },
    ])
  })

  test('an heir with the protocol on: a check line with the heir by name and the window', () => {
    const [line] = linesOf(ctxWith({ heir: 'ana', name: 'Ana', window: 21, protocol: true }))
    expect(line).toEqual({
      level: 'ok',
      name: 'succession',
      hint: 'armed (heir: Ana, window 21 days)',
    })
  })

  test('an heir without a name in the people table is shown by id', () => {
    const [line] = linesOf(ctxWith({ heir: 'ana', protocol: true }))
    expect(line?.hint).toBe('armed (heir: ana, window 14 days)')
  })

  test('the owner-absence protocol switched off is a warning', () => {
    const [line] = linesOf(ctxWith({ heir: 'ana', name: 'Ana', protocol: false }))
    expect(line?.level).toBe('warn')
    expect(line?.hint).toBe('heir Ana is named, but the owner-absence protocol is switched off')
  })

  test('the owner-absence protocol missing is a warning too', () => {
    const [line] = linesOf(ctxWith({ heir: 'ana', name: 'Ana', protocol: 'missing' }))
    expect(line?.level).toBe('warn')
    expect(line?.hint).toContain('is missing')
  })

  test('a run in its grace reads the day the grace ends', () => {
    const [line] = linesOf(ctxWith({ heir: 'ana', name: 'Ana', protocol: true, grace: true }))
    expect(line).toEqual({
      level: 'ok',
      name: 'succession',
      hint: `grace until ${new Date(NOW + 7 * DAY).toISOString()} (heir: Ana)`,
    })
  })

  test('nothing is checked when the database check failed', () => {
    const ctx = ctxWith({})
    const failed = { ...ctx, checks: [{ level: 'fail', name: 'database', hint: 'missing' }] }
    expect(linesOf(failed as DoctorCtx)).toEqual([])
  })
})
