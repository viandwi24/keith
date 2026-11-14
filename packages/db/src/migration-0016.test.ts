import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { clientsRepo } from './repos/clients.ts'
import { presenceStatusRepo } from './repos/presence-status.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P27.1.2: migration 0016 adds the presence tables (`clients`, `presence_signals`, `presence_status`,
 * `presence_disclosure`) and nothing else. Rows of older tables are unchanged; the new tables start empty and take a row.
 */
afterAll(cleanMigrationDirs)

test('0016 adds empty presence tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0016_') })
  sqlite.exec(
    `INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at)
     VALUES ('t1', 'front:ana', 'cortex.general', 'd', 'done', 1, 1, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite.query<{ id: string; status: string }, []>('SELECT id, status FROM tasks').all(),
  ).toEqual([{ id: 't1', status: 'done' }])
  for (const table of ['clients', 'presence_signals', 'presence_status', 'presence_disclosure']) {
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      table,
    ).toBe(0)
  }

  const registered = clientsRepo(sqlite).register(
    'ana',
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'tui',
      label: 'laptop',
      capabilities: ['chat'],
      version: '0.1.0',
    },
    42,
  )
  expect(registered).toMatchObject({ status: 'registered', created: true })
  presenceStatusRepo(sqlite).set('ana', { note: null, until: null, setAt: 42 })
  expect(presenceStatusRepo(sqlite).get('ana')).toMatchObject({ setAt: 42 })
})
