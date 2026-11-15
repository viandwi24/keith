import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { presenceStatusRepo } from './repos/presence-status.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * ADR-0034 §5 (P37.3): migration 0026 adds the nullable `from` column to `presence_status` and nothing else. A status
 * stored before it keeps its kind, note and end, and reads back with `from: null`.
 */
afterAll(cleanMigrationDirs)

test('0026 adds a nullable from column and keeps the stored statuses', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0026_') })
  sqlite.exec(
    `INSERT INTO presence_status (person_id, state, note, until, set_at) VALUES ('ana', 'busy', 'standup', 5000, 1)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const columns = sqlite
    .query<{ name: string; notnull: number }, []>(
      'SELECT name, "notnull" FROM pragma_table_info(\'presence_status\')',
    )
    .all()
  expect(columns.find((c) => c.name === 'from')).toEqual({ name: 'from', notnull: 0 })

  const repo = presenceStatusRepo(sqlite)
  expect(repo.get('ana')).toEqual({
    personId: 'ana',
    kind: 'busy',
    note: 'standup',
    from: null,
    until: 5000,
    setAt: 1,
  })
  repo.set('ben', { kind: 'out', note: null, from: 100, until: 200, setAt: 50 })
  expect(repo.get('ben')).toMatchObject({ kind: 'out', from: 100, until: 200 })
  sqlite.close()
})
