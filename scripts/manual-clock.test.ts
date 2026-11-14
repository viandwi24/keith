import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shiftStoredTimes, takeClockLock } from './manual-clock.ts'

const MIGRATIONS = join(import.meta.dir, '../packages/db/drizzle')
const DAY = 86_400_000
const T = Date.UTC(2026, 10, 10, 12, 0, 0)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A database with every migration applied, the way `keith-core` migrates a new data folder. */
function migratedDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'manual-clock-'))
  dirs.push(dir)
  const file = join(dir, 'keith.db')
  const db = new Database(file)
  for (const name of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, name), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim() !== '') db.run(statement)
    }
  }
  db.close()
  return { dir, file }
}

function seed(file: string): void {
  const db = new Database(file)
  db.run(
    `INSERT INTO clients (id, person_id, kind, label, capabilities, version, first_seen_at, last_seen_at, last_active_at)
     VALUES ('c1', 'owner', 'tui', 'laptop', '[]', '1', ?, ?, ?)`,
    [T - DAY, T, T],
  )
  db.run(
    `INSERT INTO presence_signals (id, person_id, type, at) VALUES ('s1', 'owner', 'activity', ?)`,
    [T],
  )
  db.run(
    `INSERT INTO succession_state (id, state, heir, started_at, grace_started_at, claimable_at, last_sign_at, updated_at)
     VALUES (1, 'grace', 'ana', ?, ?, NULL, ?, ?)`,
    [T, T, T, T],
  )
  db.run(
    `INSERT INTO protocol_runs (id, protocol_id, version, person, trigger_ref, status, started_at, updated_at, wake_at)
     VALUES ('r1', 'p1', 1, 'keith', 'absence:1', 'waiting', ?, ?, ?)`,
    [T, T, T + 7 * DAY],
  )
  db.run(
    `INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at) VALUES ('r1', 'grace-wait', 'wait', 'started', ?)`,
    [T],
  )
  db.run(
    `INSERT INTO deliveries (id, source, recipient_id, name, needs, text, status, created_at, updated_at, next_attempt_at)
     VALUES ('d1', 'test', 'owner', 'n', '{}', 'hi', 'pending', ?, ?, ?)`,
    [T, T, T],
  )
  db.run(
    `INSERT INTO dream_runs (id, person_id, trigger, mode, status, started_at, ended_at, counts, cursor, undo_until)
     VALUES ('dr1', 'owner', 'manual', 'auto', 'applied', ?, ?, '{}', '{}', ?)`,
    [T, T + 60_000, T + DAY],
  )
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('succession.pausedUntil', ?, ?)`, [
    String(T + 10 * DAY),
    T,
  ])
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES ('succession.windowDays', '14', ?)`,
    [T],
  )
  db.close()
}

function read(file: string) {
  const db = new Database(file)
  try {
    return {
      client: db
        .query<{ last_seen_at: number; last_active_at: number }, []>(
          'SELECT last_seen_at, last_active_at FROM clients',
        )
        .get(),
      signal: db.query<{ at: number }, []>('SELECT at FROM presence_signals').get(),
      state: db
        .query<
          {
            started_at: number
            grace_started_at: number
            claimable_at: number | null
            last_sign_at: number
            updated_at: number
          },
          []
        >(
          'SELECT started_at, grace_started_at, claimable_at, last_sign_at, updated_at FROM succession_state',
        )
        .get(),
      run: db
        .query<{ started_at: number; wake_at: number | null; trigger_ref: string }, []>(
          'SELECT started_at, wake_at, trigger_ref FROM protocol_runs',
        )
        .get(),
      step: db.query<{ at: number }, []>('SELECT at FROM protocol_run_steps').get(),
      delivery: db
        .query<{ next_attempt_at: number; created_at: number }, []>(
          'SELECT next_attempt_at, created_at FROM deliveries',
        )
        .get(),
      pause: db
        .query<{ value: string }, []>(
          "SELECT value FROM settings WHERE key = 'succession.pausedUntil'",
        )
        .get(),
      window: db
        .query<{ value: string }, []>(
          "SELECT value FROM settings WHERE key = 'succession.windowDays'",
        )
        .get(),
    }
  } finally {
    db.close()
  }
}

describe('shiftStoredTimes', () => {
  test('moves the timeline timestamps back by N days and nothing else', () => {
    const { file } = migratedDb()
    seed(file)
    const report = shiftStoredTimes(file, 8)
    expect(report.pauseMoved).toBe(true)
    const moved = Object.fromEntries(report.moved.map((m) => [m.column, m.rows]))
    expect(moved['presence_signals.at']).toBe(1)
    expect(moved['succession_state.grace_started_at']).toBe(1)
    expect(moved['succession_state.claimable_at']).toBe(0) // NULL is left alone

    const after = read(file)
    expect(after.signal?.at).toBe(T - 8 * DAY)
    expect(after.client).toEqual({ last_seen_at: T - 8 * DAY, last_active_at: T - 8 * DAY })
    expect(after.state).toEqual({
      started_at: T - 8 * DAY,
      grace_started_at: T - 8 * DAY,
      claimable_at: null,
      last_sign_at: T - 8 * DAY,
      updated_at: T - 8 * DAY,
    })
    expect(after.run).toEqual({
      started_at: T - 8 * DAY,
      wake_at: T - 1 * DAY,
      trigger_ref: 'absence:1',
    })
    expect(after.step?.at).toBe(T - 8 * DAY)
    expect(after.delivery).toEqual({ next_attempt_at: T - 8 * DAY, created_at: T - 8 * DAY })
    const dream = new Database(file)
      .query<{ started_at: number; ended_at: number; undo_until: number }, []>(
        'SELECT started_at, ended_at, undo_until FROM dream_runs',
      )
      .get()
    expect(dream).toEqual({
      started_at: T - 8 * DAY,
      ended_at: T + 60_000 - 8 * DAY,
      undo_until: T + DAY - 8 * DAY,
    })
    expect(after.pause?.value).toBe(String(T + 2 * DAY))
    expect(after.window?.value).toBe('14') // an unrelated setting is untouched
  })

  test('refuses a day count below one and a database without the timeline tables', () => {
    const { file } = migratedDb()
    expect(() => shiftStoredTimes(file, 0)).toThrow('whole number')
    expect(() => shiftStoredTimes(file, 1.5)).toThrow('whole number')
    seed(file)
    const db = new Database(file)
    db.run('ALTER TABLE presence_signals RENAME COLUMN at TO at_ms')
    db.close()
    // a renamed column the clock moves fails loudly, and the transaction leaves every other table as it was
    expect(() => shiftStoredTimes(file, 1)).toThrow()
    const check = new Database(file)
    expect(
      check.query<{ updated_at: number }, []>('SELECT updated_at FROM succession_state').get()
        ?.updated_at,
    ).toBe(T)
    check.close()
  })
})

describe('manual:clock command', () => {
  const run = (args: string[], env: Record<string, string>) =>
    Bun.spawn(['bun', join(import.meta.dir, 'manual-clock.ts'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })

  test('refuses a data folder that is not the test one, unless --force', async () => {
    const { dir, file } = migratedDb()
    seed(file)
    const refused = run(['8'], { KEITH_DATA_DIR: dir })
    expect(await refused.exited).toBe(2)
    expect(await new Response(refused.stderr).text()).toContain('refusing')
    expect(read(file).state?.updated_at).toBe(T)
  })

  test('refuses while a core holds core.lock', async () => {
    const { dir, file } = migratedDb()
    seed(file)
    writeFileSync(join(dir, 'core.lock'), `${process.pid}\n`)
    const held = run(['8', '--force'], { KEITH_DATA_DIR: dir })
    expect(await held.exited).toBe(1)
    expect(await new Response(held.stderr).text()).toContain('a core is running')
    expect(read(file).state?.updated_at).toBe(T)
  })

  test('takes over a stale core.lock and releases it after the shift', async () => {
    const { dir, file } = migratedDb()
    seed(file)
    const exited = Bun.spawn(['true'])
    await exited.exited
    writeFileSync(join(dir, 'core.lock'), `${exited.pid}\n`) // a pid whose process is gone
    const stale = run(['8', '--force'], { KEITH_DATA_DIR: dir })
    expect(await stale.exited).toBe(0)
    expect(read(file).state?.updated_at).toBe(T - 8 * DAY)
    expect(existsSync(join(dir, 'core.lock'))).toBe(false) // released after the shift
  })
})

describe('takeClockLock', () => {
  test('holds core.lock with our pid and refuses a second taker while it is held', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manual-clock-lock-'))
    dirs.push(dir)
    const path = join(dir, 'core.lock')
    const lock = takeClockLock(path)
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)
    expect(() => takeClockLock(path)).toThrow('a core is running')
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  test('release leaves a lock that now names another process alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manual-clock-lock-'))
    dirs.push(dir)
    const path = join(dir, 'core.lock')
    const lock = takeClockLock(path)
    writeFileSync(path, '1\n') // pid 1 is alive and not ours: it is the holder now
    lock.release()
    expect(readFileSync(path, 'utf8')).toBe('1\n')
  })
})
