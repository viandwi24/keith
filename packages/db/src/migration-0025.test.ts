import { afterAll, expect, test } from 'bun:test'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs } from './testing/migrations.ts'

/**
 * ADR-0033 §4 (amended Nov 12, 2026): migration 0025 drops the table `presence_client_context`, the per-person switch that
 * no longer exists. Nothing else changes: the client columns and the rows of the other tables stay.
 */
afterAll(cleanMigrationDirs)

test('0025 drops the client-context table and keeps the clients and their environment columns', async () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const tables = sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => t.name)
  expect(tables).not.toContain('presence_client_context')
  expect(tables).toContain('clients')

  const columns = sqlite
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('clients')")
    .all()
    .map((c) => c.name)
  expect(columns).toEqual(expect.arrayContaining(['environment', 'network']))
  sqlite.close()
})
