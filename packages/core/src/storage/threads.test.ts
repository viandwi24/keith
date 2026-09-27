import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await db.repos.persons.create(person(1))
  await db.repos.persons.create(person(2))
})
afterEach(() => db.close())

const p1 = testId('per', 1)
const p2 = testId('per', 2)

describe('threads', () => {
  test('round-trips a thread with its participants', async () => {
    const t = thread(1, p1)
    await db.repos.threads.create(t, [p1])
    expect(await db.repos.threads.get(t.id)).toEqual(t)
    expect(await db.repos.threads.getBySlug(p1, 'main')).toEqual(t)
    expect(await db.repos.threads.getBySlug(p2, 'main')).toBeNull()
    expect(await db.repos.threads.participants(t.id)).toEqual([
      { threadId: t.id, personId: p1, joinedAt: t.createdAt, leftAt: null },
    ])
  })

  test('slug is unique per owner', async () => {
    await db.repos.threads.create(thread(1, p1), [p1])
    await db.repos.threads.create(thread(2, p2), [p2])
    await expect(db.repos.threads.create(thread(3, p1), [p1])).rejects.toThrow()
    // A failed create leaves no partial rows behind.
    expect(await db.repos.threads.get(testId('thr', 3))).toBeNull()
  })

  test('I-2: a group thread keeps every participant', async () => {
    const g = thread(1, null, { kind: 'group', slug: null })
    await db.repos.threads.create(g, [p1, p2])
    expect((await db.repos.threads.participants(g.id)).map((p) => p.personId).sort()).toEqual([p1, p2])
  })

  test('lists a person’s threads, most recently updated first', async () => {
    await db.repos.threads.create(thread(1, p1), [p1])
    await db.repos.threads.create(thread(2, null, { kind: 'group', slug: null }), [p1, p2])
    await db.repos.threads.create(thread(3, p2), [p2])
    await db.repos.threads.touch(testId('thr', 1), 9_999)
    expect((await db.repos.threads.listForPerson(p1)).map((t) => t.id)).toEqual([
      testId('thr', 1),
      testId('thr', 2),
    ])
    expect((await db.repos.threads.get(testId('thr', 1)))?.updatedAt).toBe(9_999)
  })
})
