import type { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { credentialsRepo } from './repos/credentials.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P14 step 4: the migration that adds the session columns, `people.can_login` and
 * `person_identifiers` is additive. A database built from the migrations before it and filled with
 * rows (an owner with a password, a PIN and credentials) keeps every row and reads the new
 * columns as their defaults. Only fresh temp databases are used.
 */
afterAll(cleanMigrationDirs)

test('an existing database migrates without losing a row, and the new columns read as defaults', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0008_') })
  expect(sqlite.query('PRAGMA table_info(credentials)').all().length).toBe(10)

  const now = 1_790_000_000_000
  sqlite.exec(
    `INSERT INTO people (id, name, role, created_at, username, status, updated_at)
       VALUES ('owner', 'Owner', 'owner', ${now}, 'owner', 'active', ${now}),
              ('ana', 'Ana', 'member', ${now}, 'ana', 'suspended', ${now})`,
  )
  sqlite.exec(
    `INSERT INTO person_secrets (person_id, kind, hash, updated_at) VALUES
       ('owner', 'password', '$argon2id$x', ${now}), ('owner', 'pin', '$argon2id$y', ${now})`,
  )
  sqlite.exec(
    `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at, last_seen_at, last_ip, revoked_at, elevated_until)
       VALUES ('aaaaaaaaaaaa', 'owner', 'token', 'cli', 'h1', ${now}, ${now}, '127.0.0.1', NULL, ${now + 60_000}),
              ('bbbbbbbbbbbb', 'owner', 'device', 'laptop', 'h2', ${now}, NULL, NULL, ${now + 5}, NULL),
              ('cccccccccccc', 'ana', 'device', 'phone', 'h3', ${now}, NULL, NULL, NULL, NULL)`,
  )
  sqlite.exec(
    `INSERT INTO client_tokens (id, person_id, hash, label, created_at) VALUES ('t1', 'owner', 'th', 'old', ${now})`,
  )

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  const creds = sqlite
    .query<Record<string, unknown>, []>('SELECT * FROM credentials ORDER BY id')
    .all()
  expect(
    creds.map((c) => [c.id, c.kind, c.label, c.secret_hash, c.elevated_until, c.revoked_at]),
  ).toEqual([
    ['aaaaaaaaaaaa', 'token', 'cli', 'h1', now + 60_000, null],
    ['bbbbbbbbbbbb', 'device', 'laptop', 'h2', null, now + 5],
    ['cccccccccccc', 'device', 'phone', 'h3', null, null],
  ])
  for (const c of creds) {
    expect(c.methods).toBeNull()
    expect(c.assurance).toBe(0)
    expect(c.idle_expires_at).toBeNull()
    expect(c.absolute_expires_at).toBeNull()
    expect(c.user_agent).toBeNull()
    expect(c.revoked_reason).toBeNull()
  }
  const people = sqlite
    .query<{ id: string; can_login: number; status: string }, []>(
      'SELECT id, can_login, status FROM people ORDER BY id',
    )
    .all()
  expect(people).toEqual([
    { id: 'ana', can_login: 1, status: 'suspended' },
    { id: 'owner', can_login: 1, status: 'active' },
  ])
  expect(sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM person_secrets').get()?.n).toBe(
    2,
  )
  expect(sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM client_tokens').get()?.n).toBe(
    1,
  )
  // the repo still reads and lists the old rows
  expect(
    credentialsRepo(sqlite)
      .list('owner', 'token')
      .map((c) => c.id),
  ).toEqual(['aaaaaaaaaaaa'])

  // the new table: an alias is unique across people and goes with a real person
  sqlite.exec(
    `INSERT INTO person_identifiers (person_id, kind, value_norm, created_by, created_at)
       VALUES ('owner', 'email', 'vian@example.com', 'owner', ${now})`,
  )
  expect(() =>
    sqlite.exec(
      `INSERT INTO person_identifiers (person_id, kind, value_norm, created_at) VALUES ('ana', 'email', 'vian@example.com', ${now})`,
    ),
  ).toThrow()
  expect(() =>
    sqlite.exec(
      `INSERT INTO person_identifiers (person_id, kind, value_norm, created_at) VALUES ('ghost', 'phone', '+62811', ${now})`,
    ),
  ).toThrow()
  migrateDatabase(sqlite) // idempotent
  sqlite.close()
})

test('a database built from the migrations before it is behind until db:migrate runs', async () => {
  const sqlite: Database = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0008_') })
  await expect(assertMigrated(sqlite)).rejects.toThrow('bun run db:migrate')
  sqlite.close()
})
