import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'

describe('backfillPeople', () => {
  test('a stored `left` becomes `suspended`, and a second run changes nothing', () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES ('old', 'Old', 'member', 1, 'old', 'left', 1), ('ana', 'Ana', 'member', 1, 'ana', 'active', 1)",
      )
      .run()
    migrateDatabase(sqlite)
    migrateDatabase(sqlite)
    const rows = sqlite.query('SELECT id, status FROM people ORDER BY id').all() as {
      id: string
      status: string
    }[]
    expect(rows).toEqual([
      { id: 'ana', status: 'active' },
      { id: 'old', status: 'suspended' },
    ])
    sqlite.close()
  })
})
