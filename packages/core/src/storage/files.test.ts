import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { person, testId } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { FileRecord } from './types.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await db.repos.persons.create(person(1))
})
afterEach(() => db.close())

function file(n: number, patch: Partial<FileRecord> = {}): FileRecord {
  return {
    id: testId('fil', n),
    name: `photo-${n}.png`,
    path: `${testId('fil', n)}`,
    mime: 'image/png',
    size: 1234,
    ownerPersonId: testId('per', 1),
    createdAt: 5_000 + n,
    ...patch,
  }
}

describe('files', () => {
  test('round-trips a file record', async () => {
    await db.repos.files.create(file(1))
    expect(await db.repos.files.get(testId('fil', 1))).toEqual(file(1))
  })

  test('returns null for an unknown id', async () => {
    expect(await db.repos.files.get(testId('fil', 9))).toBeNull()
  })

  test('rejects a file whose owner does not exist', async () => {
    let error: unknown
    try {
      await db.repos.files.create(file(2, { ownerPersonId: testId('per', 7) }))
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
  })
})
