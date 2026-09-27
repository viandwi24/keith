import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { person, testId } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'

let db: TestDb
beforeEach(() => {
  db = createTestDb()
})
afterEach(() => db.close())

describe('persons', () => {
  test('round-trips a person by id and username', async () => {
    const p = person(1, { tier: 'owner', passwordHash: 'hash', lastSeenAt: 7 })
    await db.repos.persons.create(p)
    expect(await db.repos.persons.get(p.id)).toEqual(p)
    expect(await db.repos.persons.getByUsername('user1')).toEqual(p)
    expect(await db.repos.persons.get(testId('per', 9))).toBeNull()
    expect(await db.repos.persons.getByUsername('nobody')).toBeNull()
  })

  test('lists persons oldest first', async () => {
    await db.repos.persons.create(person(2))
    await db.repos.persons.create(person(1, { username: null }))
    expect((await db.repos.persons.list()).map((p) => p.id)).toEqual([testId('per', 1), testId('per', 2)])
  })

  test('rejects a duplicate username', async () => {
    await db.repos.persons.create(person(1))
    await expect(db.repos.persons.create(person(2, { username: 'user1' }))).rejects.toThrow()
  })

  test('sets the password hash and last seen time', async () => {
    await db.repos.persons.create(person(1))
    await db.repos.persons.create(person(2))
    await db.repos.persons.create(person(3))
    await db.repos.persons.setPasswordHash(testId('per', 1), 'argon')
    await db.repos.persons.setLastSeenAt([testId('per', 1), testId('per', 2)], 42)
    await db.repos.persons.setLastSeenAt([], 99)
    expect(await db.repos.persons.get(testId('per', 1))).toMatchObject({
      passwordHash: 'argon',
      lastSeenAt: 42,
    })
    expect((await db.repos.persons.get(testId('per', 2)))?.lastSeenAt).toBe(42)
    expect((await db.repos.persons.get(testId('per', 3)))?.lastSeenAt).toBeNull()
  })
})

describe('relationships', () => {
  test('upserts and round-trips a relationship card', async () => {
    await db.repos.persons.create(person(1))
    const personId = testId('per', 1)
    expect(await db.repos.relationships.get(personId)).toBeNull()
    await db.repos.relationships.upsert({ personId, tone: 'warm', notes: '', blockedRelayFrom: [] })
    const card = { personId, tone: 'dry', notes: 'likes rivers', blockedRelayFrom: [testId('per', 2)] }
    await db.repos.relationships.upsert(card)
    expect(await db.repos.relationships.get(personId)).toEqual(card)
  })
})
