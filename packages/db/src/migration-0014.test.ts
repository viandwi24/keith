import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { nodesRepo } from './repos/nodes.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P26 step 4.2: migrations 0013 (`nodes.token_next_hash`, `nodes.token_issued_at`) and 0014 (backfill)
 * are additive. A node joined before them keeps its token, and its issue time is its creation time.
 */
afterAll(cleanMigrationDirs)

test('an existing node keeps its token, and its issue time becomes its creation time', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0013_') })
  const created = 1_780_000_000_000
  sqlite.exec(
    `INSERT INTO nodes (id, name, os, arch, version, manifest, allow_shell, token_hash, status, created_at)
     VALUES ('n1', 'laptop-e', 'darwin', 'arm64', '0.1.0', '{}', 0, 'h1', 'offline', ${created})`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const nodes = nodesRepo(sqlite)
  expect(nodes.findByTokenHash('h1')).toMatchObject({ id: 'n1', tokenIssuedAt: created })
  expect(
    sqlite
      .query<{ token_issued_at: number; token_next_hash: string | null }, []>(
        "SELECT token_issued_at, token_next_hash FROM nodes WHERE id = 'n1'",
      )
      .get(),
  ).toEqual({ token_issued_at: created, token_next_hash: null })
})
