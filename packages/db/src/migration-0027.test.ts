import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { pushSubscriptionsRepo } from './repos/push-subscriptions.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/** ADR-0035 (W9): migration 0027 adds the `push_subscriptions` table and touches nothing else. */
afterAll(cleanMigrationDirs)

test('0027 adds push_subscriptions with a unique endpoint and keeps older rows', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0027_') })
  expect(
    sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name = 'push_subscriptions'",
      )
      .all(),
  ).toEqual([])
  sqlite.exec(
    `INSERT INTO presence_status (person_id, state, note, until, set_at) VALUES ('ana', 'busy', 'x', 5000, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const columns = sqlite
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('push_subscriptions')")
    .all()
    .map((c) => c.name)
  expect(columns).toEqual([
    'id',
    'person_id',
    'endpoint',
    'p256dh',
    'auth',
    'client_id',
    'label',
    'user_agent',
    'created_at',
    'last_success_at',
    'failure_count',
  ])
  expect(
    sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM presence_status').get()?.n,
  ).toBe(1)

  const repo = pushSubscriptionsRepo(sqlite)
  const row = {
    id: 'a',
    personId: 'ana',
    endpoint: 'https://push.example/x',
    p256dh: 'p',
    auth: 'a',
    label: '',
    userAgent: '',
    createdAt: 1,
  }
  repo.upsert(row)
  expect(() =>
    sqlite
      .query(
        `INSERT INTO push_subscriptions (id, person_id, endpoint, p256dh, auth, label, user_agent, created_at) VALUES ('b', 'ben', 'https://push.example/x', 'p', 'a', '', '', 1)`,
      )
      .run(),
  ).toThrow()
  sqlite.close()
})
