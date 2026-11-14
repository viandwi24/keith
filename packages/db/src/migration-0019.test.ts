import { afterAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from './connection.ts'
import { cleanMigrationDirs, migrationsBefore } from './testing/migrations.ts'

/**
 * P30.1.3: migration 0019 adds the shared-room tables `rooms`, `room_members`, `room_events` and `room_requests`
 * (docs/specs/corpus-callosum.md, "Data model") and nothing else. Rows of older tables are unchanged; the new tables start
 * empty; the primary keys, the foreign keys, the one-active-room partial index and the CHECKs hold on a migrated database.
 */
afterAll(cleanMigrationDirs)

const TABLES = ['rooms', 'room_members', 'room_events', 'room_requests']

const ROOM = `INSERT INTO rooms (id, name, initiator, state, created_at)
  VALUES ('room-1', 'Planning', 'ana', 'open', 1)`

test('0019 adds empty room tables and leaves the rows of older tables alone', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0019_') })
  sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('rooms.maxMembers', '8', 1)`)
  sqlite.exec(`INSERT INTO presence_status (person_id, state, set_at) VALUES ('ana', 'busy', 1)`)

  migrateDatabase(sqlite)
  await assertMigrated(sqlite)

  expect(
    sqlite
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'rooms.maxMembers'")
      .all(),
  ).toEqual([{ value: '8' }])
  expect(
    sqlite.query<{ person_id: string }, []>('SELECT person_id FROM presence_status').all(),
  ).toEqual([{ person_id: 'ana' }])
  for (const table of TABLES) {
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      table,
    ).toBe(0)
  }

  // primary keys: one id per room, one row per (room, person), one seq per event
  sqlite.exec(ROOM)
  expect(() => sqlite.exec(ROOM)).toThrow(/UNIQUE constraint failed/)
  sqlite.exec(
    `INSERT INTO room_members (room_id, person_id, status, invited_at, joined_at)
     VALUES ('room-1', 'ana', 'active', 1, 1)`,
  )
  expect(() =>
    sqlite.exec(
      `INSERT INTO room_members (room_id, person_id, status, invited_at)
       VALUES ('room-1', 'ana', 'invited', 1)`,
    ),
  ).toThrow(/UNIQUE constraint failed/)
  sqlite.exec(
    `INSERT INTO room_events (room_id, at, kind, speaker, text) VALUES ('room-1', 1, 'say', 'ana', 'hi')`,
  )
  sqlite.exec(
    `INSERT INTO room_events (room_id, at, kind, speaker, text) VALUES ('room-1', 2, 'say', 'ana', 'again')`,
  )
  expect(
    sqlite.query<{ seq: number }, []>('SELECT seq FROM room_events ORDER BY seq').all(),
  ).toEqual([{ seq: 1 }, { seq: 2 }])

  // foreign keys: members, events and requests name an existing room
  expect(() =>
    sqlite.exec(
      `INSERT INTO room_members (room_id, person_id, status, invited_at)
       VALUES ('no-such-room', 'bob', 'invited', 1)`,
    ),
  ).toThrow(/FOREIGN KEY constraint failed/)
  expect(() =>
    sqlite.exec(`INSERT INTO room_events (room_id, at, kind) VALUES ('no-such-room', 1, 'say')`),
  ).toThrow(/FOREIGN KEY constraint failed/)
  expect(() =>
    sqlite.exec(
      `INSERT INTO room_requests (id, room_id, person, kind, status, created_at, expires_at)
       VALUES ('q0', 'no-such-room', 'ana', 'end', 'pending', 1, 2)`,
    ),
  ).toThrow(/FOREIGN KEY constraint failed/)

  // the CHECKs of the states and kinds
  expect(() =>
    sqlite.exec(
      `INSERT INTO rooms (id, name, initiator, state, created_at) VALUES ('r9', 'x', 'ana', 'closed', 1)`,
    ),
  ).toThrow(/CHECK constraint failed/)
  expect(() =>
    sqlite.exec(`INSERT INTO room_events (room_id, at, kind) VALUES ('room-1', 3, 'whisper')`),
  ).toThrow(/CHECK constraint failed/)

  // deleting a room removes its members, events and requests
  sqlite.exec(
    `INSERT INTO room_requests (id, room_id, person, kind, status, created_at, expires_at)
     VALUES ('q1', 'room-1', 'ana', 'end', 'pending', 1, 2)`,
  )
  sqlite.exec("DELETE FROM rooms WHERE id = 'room-1'")
  for (const table of ['room_members', 'room_events', 'room_requests']) {
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      table,
    ).toBe(0)
  }
  sqlite.close()
})
