/**
 * Manual time travel for the walk-through of docs/manual-testing.md (Scenario 23, P29.3.6): `bun run manual:clock <days>`
 * moves the stored timestamps that the succession timeline reads back by N days, so a weeks-long run can be walked by hand.
 *
 *   KEITH_HOME=.data/test bun run manual:clock 8
 *
 * The core must be stopped, and the data folder must be the test one (`.data/test/data`) unless `--force`. The run takes
 * the same `core.lock` the core takes (a live pid refuses, a stale one is taken over) and holds it while the times move,
 * so a core cannot start in the middle. Nothing else changes: no row is added or removed, no other column moves. Plain
 * `bun:sqlite` and `node:fs`, because scripts import no workspace package; the names below are the migrations' column
 * names (packages/db/src/schema/*.ts).
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DAY_MS = 86_400_000
/** The setting the sign of life reads as a pause (docs/specs/succession.md, "Pause"). */
const PAUSE_KEY = 'succession.pausedUntil'

/** The timestamp columns of the succession timeline: the owner's signals, the clients, the state, the runs and the steps. */
export const CLOCK_COLUMNS: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'presence_signals', columns: ['at'] },
  { table: 'clients', columns: ['last_seen_at', 'last_active_at'] },
  { table: 'presence_status', columns: ['set_at', 'until'] },
  {
    table: 'succession_state',
    columns: ['started_at', 'grace_started_at', 'claimable_at', 'last_sign_at', 'updated_at'],
  },
  { table: 'protocol_runs', columns: ['started_at', 'updated_at', 'ended_at', 'wake_at'] },
  { table: 'protocol_run_steps', columns: ['at'] },
  // the absence trigger counts silence from the later of the last sign and the time the protocol version was saved
  { table: 'protocols', columns: ['created_at'] },
  { table: 'protocol_versions', columns: ['saved_at'] },
  { table: 'protocol_proposals', columns: ['created_at', 'expires_at'] },
  { table: 'agenda_items', columns: ['starts_at', 'ends_at', 'created_at', 'updated_at'] },
  { table: 'deliveries', columns: ['created_at', 'updated_at', 'next_attempt_at'] },
  // the dreaming runs: when each ran, when it ended, and until when an auto apply can be undone (dreaming.md)
  { table: 'dream_runs', columns: ['started_at', 'ended_at', 'undo_until'] },
]

export interface ShiftReport {
  /** Rows changed per `table.column` (null columns are not counted). */
  moved: Array<{ column: string; rows: number }>
  /** True when the sign-of-life pause was moved too. */
  pauseMoved: boolean
}

/**
 * Move every timestamp of CLOCK_COLUMNS and the succession pause back by `days` in the database at `dbFile`, in one
 * transaction. A renamed table or column makes SQLite throw, so the transaction rolls back and nothing moves.
 */
export function shiftStoredTimes(dbFile: string, days: number): ShiftReport {
  if (!Number.isInteger(days) || days < 1)
    throw new Error('days must be a whole number, at least 1')
  const ms = days * DAY_MS
  const db = new Database(dbFile)
  try {
    return db.transaction((): ShiftReport => {
      const moved: ShiftReport['moved'] = []
      for (const { table, columns } of CLOCK_COLUMNS) {
        for (const column of columns) {
          const changed = db
            .prepare(
              `UPDATE "${table}" SET "${column}" = "${column}" - ? WHERE "${column}" IS NOT NULL`,
            )
            .run(ms).changes
          moved.push({ column: `${table}.${column}`, rows: changed })
        }
      }
      const pause = db
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
        .get(PAUSE_KEY)
      let pauseMoved = false
      if (pause !== null) {
        const until: unknown = JSON.parse(pause.value)
        if (typeof until === 'number') {
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
            JSON.stringify(until - ms),
            PAUSE_KEY,
          )
          pauseMoved = true
        }
      }
      return { moved, pauseMoved }
    })()
  } finally {
    db.close()
  }
}

/** True when the pid names a live process (EPERM: alive, not ours). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The core's lock, held by this run: `release` removes it only while it still names this process. */
export interface ClockLock {
  release(): void
}

/** The pid in the lock, or undefined when the file vanished or holds no pid. */
function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Create `path` with our pid, exclusively. False when it already exists. */
function createExclusive(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Take `core.lock` in the core's format (a pid, created exclusively; see apps/core/src/modules/admin/lockfile.ts).
 * A live pid throws; a stale one (dead pid, or no pid) is removed and the lock is created again. The core's
 * takeover guard is not reimplemented: this is a development script, run with the core stopped.
 */
export function takeClockLock(path: string): ClockLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(path)) {
      let released = false
      return {
        release() {
          if (released) return
          released = true
          if (readPid(path) === process.pid) rmSync(path, { force: true })
        },
      }
    }
    const pid = readPid(path)
    if (pid !== undefined && alive(pid))
      throw new Error(`a core is running (pid ${pid}): stop it first`)
    rmSync(path, { force: true }) // stale: its process is gone
  }
  throw new Error(`could not take ${path}: another process keeps taking it`)
}

function fail(message: string, code: number): never {
  console.error(`manual:clock: ${message}`)
  process.exit(code)
}

function main(argv: string[]): void {
  const force = argv.includes('--force')
  const positional = argv.filter((arg) => arg !== '--force')
  const usage =
    'usage: bun run manual:clock <days> [--force]   (KEITH_HOME=.data/test, core stopped)'
  if (positional.length !== 1 || !/^\d+$/.test(positional[0] ?? '')) fail(usage, 2)
  const days = Number(positional[0])
  if (days < 1) fail(usage, 2)

  const home = process.env.KEITH_HOME
  const dataDir = process.env.KEITH_DATA_DIR || (home ? join(home, 'data') : undefined)
  if (dataDir === undefined) fail('set KEITH_HOME=.data/test (no default data folder is used)', 2)
  const testDataDir = resolve(ROOT, '.data/test/data')
  if (!force && resolve(dataDir) !== testDataDir)
    fail(
      `refusing ${resolve(dataDir)}: only ${testDataDir} (KEITH_HOME=.data/test); --force overrides`,
      2,
    )

  const dbFile = join(dataDir, 'keith.db')
  if (!existsSync(dbFile)) fail(`no database at ${dbFile}: run bun run manual:setup first`, 1)
  let lock: ClockLock
  try {
    lock = takeClockLock(join(dataDir, 'core.lock'))
  } catch (error) {
    fail((error as Error).message, 1)
  }
  let report: ShiftReport
  try {
    report = shiftStoredTimes(dbFile, days)
  } finally {
    lock.release()
  }
  const rows = report.moved.reduce((sum, m) => sum + m.rows, 0)
  console.log(`moved ${rows} timestamps back ${days} day(s) in ${dbFile}`)
  for (const m of report.moved) if (m.rows > 0) console.log(`  ${m.column}: ${m.rows}`)
  if (report.pauseMoved) console.log(`  settings.${PAUSE_KEY}: moved`)
  console.log('start the core again: bun run manual:core')
}

if (import.meta.main) main(process.argv.slice(2))
