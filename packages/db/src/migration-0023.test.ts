import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { activityLogsRepo } from './activity-logs-repo.ts'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P36.2.1: migration 0023 adds the tables `llm_sessions`, `llm_calls` and `llm_bodies` (docs/specs/activity-logs.md, ADR-0032 §3)
 * and nothing else. Rows of older tables are unchanged; the three new tables start empty.
 */
afterAll(cleanMigrationDirs)

test('0023 adds three empty activity-log tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0023_') })
  sqlite.exec(`INSERT INTO people (id, name, role, created_at) VALUES ('ana', 'Ana', 'member', 1)`)
  sqlite.exec(
    `INSERT INTO front_generations (person_id, generation, updated_at) VALUES ('ana', 3, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(sqlite.query<{ id: string }, []>('SELECT id FROM people').all()).toEqual([{ id: 'ana' }])
  expect(
    sqlite.query<{ generation: number }, []>('SELECT generation FROM front_generations').get()
      ?.generation,
  ).toBe(3)
  for (const table of ['llm_sessions', 'llm_calls', 'llm_bodies']) {
    expect(sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
  }
  expect(activityLogsRepo(sqlite).status()).toEqual({
    sessions: 0,
    calls: 0,
    bodies: 0,
    bodyBytes: 0,
  })
  sqlite.close()
})
