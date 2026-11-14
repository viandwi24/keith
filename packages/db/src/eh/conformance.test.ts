/** The eharness conformance suites against Keith's SQLite adapters (file database in a temp dir). */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityStoreConformance,
  budgetLedgerConformance,
  inboxAdapterConformance,
  lockConformance,
  messageAdapterConformance,
  personStoreConformance,
  profileStoreConformance,
  stateAdapterConformance,
  streamLogConformance,
} from 'eharness/testing'
import { migrateDatabase, openDatabase } from '../connection.ts'
import { sqliteActivityStore } from './activity-store.ts'
import { setBudgetLimit, sqliteBudgetLedger } from './budget-ledger.ts'
import { sqliteInbox } from './inbox.ts'
import { sqliteLock } from './lock.ts'
import { sqliteMessages, sqliteState } from './messages.ts'
import { sqlitePersonStore } from './person-store.ts'
import { sqliteProfileStore } from './profile-store.ts'
import type { Sqlite } from './sql.ts'
import { sqliteStreamLog } from './stream-log.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-conformance-'))
const opened: Sqlite[] = []
const open = (file: string): Sqlite => {
  const sqlite = openDatabase(file)
  migrateDatabase(sqlite)
  opened.push(sqlite)
  return sqlite
}
const main = open(join(dir, 'keith.db'))
afterAll(() => {
  for (const sqlite of opened) sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function suite(name: string, cases: Array<{ name: string; run: () => Promise<void> | void }>) {
  describe(name, () => {
    for (const c of cases) test(c.name, c.run)
  })
}

suite(
  'MessageAdapter (SQLite)',
  messageAdapterConformance(() => sqliteMessages(main), { requireLastId: true }),
)
suite(
  'StateAdapter (SQLite)',
  stateAdapterConformance(() => sqliteState(main)),
)
suite(
  'InboxAdapter (SQLite)',
  inboxAdapterConformance(() => sqliteInbox(main), {
    requirePending: true,
    requireRetry: true,
    requireDeadLetter: true,
    requireStats: true,
    requireDedupe: true,
    claimTtlMs: 200,
  }),
)
// every case gets an empty store: the suite assumes an isolated adapter per call
suite(
  'ProfileStore (SQLite)',
  profileStoreConformance(() => sqliteProfileStore(open(':memory:')), { requireSubscribe: true }),
)
suite(
  'SessionLock (SQLite)',
  lockConformance(() => {
    // a second connection to the same file is "another instance"
    const file = join(dir, `lock-${crypto.randomUUID()}.db`)
    const own = open(file)
    return {
      lock: sqliteLock(own, { leaseMs: 60_000 }),
      peer: () => sqliteLock(open(file), { leaseMs: 60_000 }),
      // a crashed holder stops renewing: its lease runs out without a release
      expire: (sessionId) => {
        own.query('UPDATE eh_locks SET until = 0 WHERE session_id = ?').run(sessionId)
      },
    }
  }),
)
suite(
  'ActivityStore (SQLite)',
  activityStoreConformance(() => {
    // a second connection to the same file is "another instance"
    const file = join(dir, `activity-${crypto.randomUUID()}.db`)
    const own = open(file)
    return {
      store: sqliteActivityStore(own),
      peer: () => sqliteActivityStore(open(file)),
    }
  }),
)
suite(
  'StreamLog (SQLite)',
  streamLogConformance(() => sqliteStreamLog(open(':memory:'))),
)
suite('StreamLog purge (SQLite)', [
  {
    name: 'an expired log leaves no chunk after purgeExpired, with no read or append',
    run: async () => {
      let clock = 1_000
      const sqlite = open(':memory:')
      const log = sqliteStreamLog(sqlite, { retentionMs: 1_000, now: () => clock })
      const key = { sessionId: 'front:ana', turnId: 'turn-1' }
      await log.append(key, ['a', 'b', 'c'])
      await log.close(key, 'done')
      const rows = (table: string): number =>
        sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1
      expect(rows('eh_stream_chunks')).toBe(3)
      clock += 999
      expect(log.purgeExpired()).toBe(0)
      clock += 2
      expect(log.purgeExpired()).toBe(1)
      expect(rows('eh_stream_chunks')).toBe(0)
      expect(rows('eh_stream_log')).toBe(0)
    },
  },
])
suite(
  'BudgetLedger (SQLite)',
  budgetLedgerConformance((limits) => {
    const sqlite = open(':memory:')
    for (const [scope, usd] of Object.entries(limits)) setBudgetLimit(sqlite, scope, usd)
    return sqliteBudgetLedger(sqlite)
  }),
)

suite(
  'PersonStore (SQLite)',
  personStoreConformance(() => {
    // every case gets its own database: people and codes do not leak between cases
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    opened.push(sqlite)
    return sqlitePersonStore(sqlite)
  }),
)
