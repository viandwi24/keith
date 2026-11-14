import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { deliveriesRepo } from './repos/deliveries.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P25.1.2: migration 0015 adds the `deliveries` table and nothing else. Rows of older tables are unchanged, and the
 * new table starts empty and takes a delivery at once.
 */
afterAll(cleanMigrationDirs)

test('0015 adds an empty deliveries table and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0015_') })
  sqlite.exec(
    `INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at)
     VALUES ('t1', 'front:ana', 'cortex.general', 'd', 'done', 1, 1, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite.query<{ id: string; status: string }, []>('SELECT id, status FROM tasks').all(),
  ).toEqual([{ id: 't1', status: 'done' }])
  expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM deliveries').get()?.n).toBe(0)

  const created = deliveriesRepo(sqlite, { now: () => 42 }).create({
    id: 'run-1',
    source: 'plugin:reminders',
    recipientId: 'ana',
    name: 'reminder',
    needs: '{}',
    text: 'x',
  })
  expect(created.record).toMatchObject({ status: 'pending', nextAttemptAt: 42 })
})
