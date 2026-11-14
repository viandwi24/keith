import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P29.1.4: migration 0018 adds the `succession_state` table (docs/specs/succession.md) and nothing else. Rows of older
 * tables are unchanged; the new table starts empty; its one-row and known-state CHECKs hold on a migrated database.
 */
afterAll(cleanMigrationDirs)

test('0018 adds an empty succession_state table and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0018_') })
  sqlite.exec(
    `INSERT INTO settings (key, value, updated_at) VALUES ('succession.windowDays', '14', 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite
      .query<{ value: string }, []>(
        "SELECT value FROM settings WHERE key = 'succession.windowDays'",
      )
      .all(),
  ).toEqual([{ value: '14' }])
  expect(
    sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM succession_state').get()?.n,
  ).toBe(0)

  sqlite.exec(`INSERT INTO succession_state (id, state, updated_at) VALUES (1, 'idle', 1)`)
  expect(() =>
    sqlite.exec(`INSERT INTO succession_state (id, state, updated_at) VALUES (1, 'idle', 1)`),
  ).toThrow(/UNIQUE constraint failed/)
  sqlite.close()
})
