import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P15 step 3: the migration that adds `groups`, `group_members`, `resources` and `resource_acl` is
 * additive. A database built from the migrations before it, with people, credentials, an audit log and
 * settings, keeps every row; the new tables start empty and work. Only fresh temp databases are used.
 */
afterAll(cleanMigrationDirs)

test('an existing database migrates without losing a row and gains empty ACL tables', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0009_') })
  const tables = () =>
    sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name)
  expect(tables()).not.toContain('resources')

  const now = 1_790_000_000_000
  sqlite.exec(
    `INSERT INTO people (id, name, role, created_at, username, status, updated_at)
       VALUES ('owner', 'Owner', 'owner', ${now}, 'owner', 'active', ${now}),
              ('ana', 'Ana', 'member', ${now}, 'ana', 'active', ${now})`,
  )
  sqlite.exec(
    `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at) VALUES ('aaaaaaaaaaaa', 'owner', 'token', 'cli', 'h1', ${now})`,
  )
  sqlite.exec(
    `INSERT INTO audit_events (at, kind, actor, via, detail) VALUES (${now}, 'person.created', 'owner', 'local', '{}'), (${now + 1}, 'auth.login.ok', 'ana', 'tcp', '{}')`,
  )
  sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '"x"', ${now})`)

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const count = (table: string) =>
    sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n
  expect([count('people'), count('credentials'), count('audit_events'), count('settings')]).toEqual(
    [2, 1, 2, 1],
  )
  for (const t of ['groups', 'group_members', 'resources', 'resource_acl']) {
    expect(tables()).toContain(t)
    expect(count(t)).toBe(0)
  }
  expect(
    sqlite
      .query<{ name: string }, []>('SELECT name FROM people ORDER BY id')
      .all()
      .map((p) => p.name),
  ).toEqual(['Ana', 'Owner'])

  // the new tables work, and removing a person is not blocked by what they own
  sqlite.exec(
    `INSERT INTO resources (kind, id, owner_id, mode, created_at, updated_at) VALUES ('note', 'n1', 'ana', 384, ${now}, ${now})`,
  )
  sqlite.exec(
    `INSERT INTO resource_acl (kind, id, subject_kind, subject_id, bits, effect, created_by, created_at) VALUES ('note', 'n1', 'user', 'owner', 4, 'allow', 'ana', ${now})`,
  )
  sqlite.exec("DELETE FROM people WHERE id = 'ana'")
  expect(count('resources')).toBe(1)
  expect(() =>
    sqlite.exec(
      `INSERT INTO resource_acl (kind, id, subject_kind, bits, effect, created_by, created_at) VALUES ('note', 'ghost', 'public', 4, 'allow', 'x', ${now})`,
    ),
  ).toThrow() // an entry needs its resource
  migrateDatabase(sqlite) // idempotent
  sqlite.close()
})
