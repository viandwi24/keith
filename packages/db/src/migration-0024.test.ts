import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * docs/decisions/0033 §2: migration 0024 adds `clients.environment` and `clients.network` (both null for the rows that
 * exist). Rows of older tables are unchanged. (Its table `presence_client_context` is dropped by 0025.)
 */
afterAll(cleanMigrationDirs)

test('0024 adds two client columns and keeps the existing clients', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0024_') })
  sqlite.exec(
    `INSERT INTO clients (id, person_id, kind, label, capabilities, version, first_seen_at, last_seen_at, last_active_at)
     VALUES ('c1', 'ana', 'tui', 'desk', '["chat"]', '0.1.0', 1, 2, NULL)`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const row = sqlite
    .query<{ label: string; environment: string | null; network: string | null }, []>(
      'SELECT label, environment, network FROM clients',
    )
    .get()
  expect(row).toEqual({ label: 'desk', environment: null, network: null })
  sqlite.close()
})
