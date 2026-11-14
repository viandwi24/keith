import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P33.2.1: migration 0020 adds the prefrontal tables `persona`, `persona_versions` and `person_style` (docs/specs/prefrontal.md,
 * "Data model") and nothing else. Rows of older tables are unchanged; the new tables start empty; the singleton CHECK, the
 * unique version, the foreign key of a style to a person and the CHECKs of the enums hold on a migrated database.
 */
afterAll(cleanMigrationDirs)

const TABLES = ['persona', 'persona_versions', 'person_style']

const BODY = JSON.stringify({
  tone: 'calm',
  attitude: 'helpful',
  humour: 'dry',
  addressing: 'by name',
  caresAbout: 'the owner',
  lines: { answerFailed: 'Could not answer.', guestUnavailable: 'Unavailable.' },
})

const PERSONA = `INSERT INTO persona (id, version, template_id, body, updated_at, updated_by)
  VALUES ('keith', 1, 'professional', '${BODY}', 1, 'owner')`

const VERSION = (id: string, version: number) => `INSERT INTO persona_versions
  (id, version, template_id, body, reason, changed_by, changed_at)
  VALUES ('${id}', ${version}, 'professional', '${BODY}', 'template', 'owner', 1)`

test('0020 adds empty persona tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0020_') })
  sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '"x"', 1)`)
  sqlite.exec(`INSERT INTO people (id, name, role, created_at) VALUES ('ana', 'Ana', 'member', 1)`)

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'model.front'")
      .all(),
  ).toEqual([{ value: '"x"' }])
  expect(sqlite.query<{ id: string }, []>('SELECT id FROM people').all()).toEqual([{ id: 'ana' }])
  for (const table of TABLES) {
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      table,
    ).toBe(0)
  }

  // the singleton row and its CHECKs
  expect(() =>
    sqlite.exec(
      `INSERT INTO persona (id, version, template_id, body, updated_at, updated_by)
       VALUES ('other', 1, 'professional', '{}', 1, 'owner')`,
    ),
  ).toThrow(/CHECK constraint failed/)
  expect(() =>
    sqlite.exec(
      `INSERT INTO persona (id, version, template_id, body, updated_at, updated_by)
       VALUES ('keith', 1, 'pirate', '{}', 1, 'owner')`,
    ),
  ).toThrow(/CHECK constraint failed/)
  sqlite.exec(PERSONA)
  expect(() => sqlite.exec(PERSONA)).toThrow(/UNIQUE constraint failed/)

  // the history: one row per version, a second row with the same version is refused
  sqlite.exec(VERSION('v1', 1))
  sqlite.exec(VERSION('v2', 2))
  expect(() => sqlite.exec(VERSION('v3', 2))).toThrow(/UNIQUE constraint failed/)
  expect(() => sqlite.exec(VERSION('v1', 3))).toThrow(/UNIQUE constraint failed/)
  expect(() =>
    sqlite.exec(
      `INSERT INTO persona_versions (id, version, template_id, body, reason, changed_by, changed_at)
       VALUES ('v4', 4, 'professional', '{}', 'whim', 'owner', 1)`,
    ),
  ).toThrow(/CHECK constraint failed/)
  expect(
    sqlite
      .query<{ version: number }, []>('SELECT version FROM persona_versions ORDER BY version')
      .all(),
  ).toEqual([{ version: 1 }, { version: 2 }])

  // a style names an existing person; the enums and the address length are CHECKs
  expect(() =>
    sqlite.exec(
      `INSERT INTO person_style (person_id, updated_at, updated_by) VALUES ('nobody', 1, 'nobody')`,
    ),
  ).toThrow(/FOREIGN KEY constraint failed/)
  sqlite.exec(
    `INSERT INTO person_style (person_id, address, brevity, formality, gentle_topics, updated_at, updated_by)
     VALUES ('ana', 'Ana', 'short', 'casual', '["money"]', 1, 'ana')`,
  )
  expect(() =>
    sqlite.exec(
      `INSERT INTO person_style (person_id, updated_at, updated_by) VALUES ('ana', 2, 'ana')`,
    ),
  ).toThrow(/UNIQUE constraint failed/)
  expect(() =>
    sqlite.exec(`UPDATE person_style SET brevity = 'long' WHERE person_id = 'ana'`),
  ).toThrow(/CHECK constraint failed/)
  expect(() =>
    sqlite.exec(`UPDATE person_style SET formality = 'rude' WHERE person_id = 'ana'`),
  ).toThrow(/CHECK constraint failed/)
  expect(() =>
    sqlite.exec(`UPDATE person_style SET language = 'klingon' WHERE person_id = 'ana'`),
  ).toThrow(/CHECK constraint failed/)
  expect(() =>
    sqlite.exec(`UPDATE person_style SET address = '${'x'.repeat(41)}' WHERE person_id = 'ana'`),
  ).toThrow(/CHECK constraint failed/)

  // a person's removal is the registry's job: the foreign key has no cascade
  expect(() => sqlite.exec(`DELETE FROM people WHERE id = 'ana'`)).toThrow(
    /FOREIGN KEY constraint failed/,
  )
  sqlite.close()
})
