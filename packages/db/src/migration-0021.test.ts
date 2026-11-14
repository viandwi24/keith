import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P34.2.1: migration 0021 adds the table `front_generations` (docs/specs/chat-context.md, ADR-0030 §2) and nothing else. Rows
 * of older tables are unchanged; the new table starts empty; the primary key on the person holds; there is no foreign key, so
 * a row of a person who is not in `people` is accepted (a removed person's row stays until the purge).
 */
afterAll(cleanMigrationDirs)

test('0021 adds an empty front_generations table and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0021_') })
  sqlite.exec(`INSERT INTO people (id, name, role, created_at) VALUES ('ana', 'Ana', 'member', 1)`)
  sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '"x"', 1)`)

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(sqlite.query<{ id: string }, []>('SELECT id FROM people').all()).toEqual([{ id: 'ana' }])
  expect(
    sqlite
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model.front'")
      .all(),
  ).toEqual([{ value: '"x"' }])
  expect(
    sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM front_generations').get()?.n,
  ).toBe(0)

  // one row per person; a second row for the same person is refused
  sqlite.exec(
    `INSERT INTO front_generations (person_id, generation, updated_at) VALUES ('ana', 1, 1)`,
  )
  expect(() =>
    sqlite.exec(
      `INSERT INTO front_generations (person_id, generation, updated_at) VALUES ('ana', 2, 2)`,
    ),
  ).toThrow(/UNIQUE constraint failed/)
  // no foreign key: a person id that is not in `people` is accepted
  sqlite.exec(
    `INSERT INTO front_generations (person_id, generation, updated_at) VALUES ('gone', 1, 1)`,
  )
  sqlite.close()
})
