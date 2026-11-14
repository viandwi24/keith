import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { dreamingRepo } from './repos/dreaming.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P35.2.1: migration 0022 adds the tables `dream_settings` and `dream_runs` (docs/specs/dreaming.md, ADR-0031 §5, §8) and
 * nothing else. Rows of older tables are unchanged; both new tables start empty; one mode row per person holds.
 */
afterAll(cleanMigrationDirs)

test('0022 adds two empty dreaming tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0022_') })
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
  for (const table of ['dream_settings', 'dream_runs']) {
    expect(sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
  }

  // setMode twice for the same person is one row
  const repo = dreamingRepo(sqlite)
  repo.setMode('ana', 'propose', 'ana')
  repo.setMode('ana', 'off', 'ana')
  expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM dream_settings').get()?.n).toBe(
    1,
  )
  expect(repo.getMode('ana')).toBe('off')
  sqlite.close()
})
