import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P28.1.4: migration 0017 adds the hypothalamus tables (`protocols`, `protocol_versions`, `protocol_runs`,
 * `protocol_run_steps`, `protocol_proposals`, `agenda_items`) and nothing else. Rows of older tables are unchanged; the
 * new tables start empty; the trigger guard of a run and the built-in guard of a protocol reject a duplicate.
 */
afterAll(cleanMigrationDirs)

const TABLES = [
  'protocols',
  'protocol_versions',
  'protocol_runs',
  'protocol_run_steps',
  'protocol_proposals',
  'agenda_items',
]

test('0017 adds empty hypothalamus tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0017_') })
  sqlite.exec(
    `INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at)
     VALUES ('t1', 'front:ana', 'cortex.general', 'd', 'done', 1, 1, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite.query<{ id: string; status: string }, []>('SELECT id, status FROM tasks').all(),
  ).toEqual([{ id: 't1', status: 'done' }])
  for (const table of TABLES) {
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      table,
    ).toBe(0)
  }

  sqlite.exec(
    `INSERT INTO protocols (id, owner, name, built_in, enabled, version, created_by, created_at, updated_at)
     VALUES ('pr1', 'keith', 'approval-stale', 'approval-stale', 1, 1, 'owner', 1, 1)`,
  )
  sqlite.exec(
    `INSERT INTO protocol_versions (protocol_id, version, definition, saved_by, saved_at)
     VALUES ('pr1', 1, '{}', 'owner', 1)`,
  )
  sqlite.exec(
    `INSERT INTO protocol_runs (id, protocol_id, version, person, trigger_ref, status, started_at, updated_at)
     VALUES ('r1', 'pr1', 1, 'keith', 'absence:1', 'running', 1, 1)`,
  )
  expect(() =>
    sqlite.exec(
      `INSERT INTO protocol_runs (id, protocol_id, version, person, trigger_ref, status, started_at, updated_at)
       VALUES ('r2', 'pr1', 1, 'keith', 'absence:1', 'running', 1, 1)`,
    ),
  ).toThrow(/UNIQUE constraint failed/)
  expect(() =>
    sqlite.exec(
      `INSERT INTO protocols (id, owner, name, built_in, enabled, version, created_by, created_at, updated_at)
       VALUES ('pr2', 'keith', 'other', 'approval-stale', 1, 1, 'owner', 1, 1)`,
    ),
  ).toThrow(/UNIQUE constraint failed/)
  sqlite.exec(
    `INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at) VALUES ('r1', 'a', 'notify', 'started', 1)`,
  )
  sqlite.exec("DELETE FROM protocols WHERE id = 'pr1'")
  expect(
    sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM protocol_versions').get()?.n,
  ).toBe(0)
  sqlite.close()
})
