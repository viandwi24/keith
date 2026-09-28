import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ThreadId } from '../shared/types.ts'
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
    // Phase 4: both cursors come back null when unset; phase 5: so does purpose.
    const stored = { ...t, summaryThroughSeq: null, reflectedThroughSeq: null, purpose: null }
    expect(await db.repos.threads.get(t.id)).toEqual(stored)
    expect(await db.repos.threads.getBySlug(p1, 'main')).toEqual(stored)
    expect(await db.repos.threads.listForPerson(p1)).toEqual([stored])
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

/** Appends `count` user messages to a thread, created at 1 so they never move `updated_at`. */
async function addMessages(threadId: ThreadId, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.repos.messages.append({
      id: testId('msg', nextMessage++),
      threadId,
      role: 'user',
      authorPersonId: null,
      nodeId: null,
      modality: 'text',
      content: 'x',
      meta: null,
      createdAt: 1,
    })
  }
}
let nextMessage = 1

describe('thread cursors (phase 4)', () => {
  test('create stores cursors as given', async () => {
    const t = thread(1, p1, { summaryThroughSeq: 4, reflectedThroughSeq: 2 })
    await db.repos.threads.create(t, [p1])
    expect(await db.repos.threads.get(t.id)).toEqual({ ...t, purpose: null })
  })

  test('setSummary round-trips and leaves updated_at alone', async () => {
    const t = thread(1, p1)
    await db.repos.threads.create(t, [p1])
    await db.repos.threads.setSummary(t.id, { summary: 'They planned the river trip.', throughSeq: 12 })
    expect(await db.repos.threads.get(t.id)).toEqual({
      ...t,
      summary: 'They planned the river trip.',
      summaryThroughSeq: 12,
      reflectedThroughSeq: null,
      purpose: null,
    })
    // A missing thread is a no-op.
    await db.repos.threads.setSummary(testId('thr', 99), { summary: 'x', throughSeq: 1 })
    expect(await db.repos.threads.get(testId('thr', 99))).toBeNull()
  })

  test('setReflectedThrough moves the cursor and leaves updated_at alone', async () => {
    const t = thread(1, p1)
    await db.repos.threads.create(t, [p1])
    await db.repos.threads.setReflectedThrough(t.id, 7)
    expect(await db.repos.threads.get(t.id)).toEqual({
      ...t,
      summaryThroughSeq: null,
      reflectedThroughSeq: 7,
      purpose: null,
    })
  })

  describe('listForReflection', () => {
    const idleBefore = 5_000
    beforeEach(async () => {
      nextMessage = 1
      // 1: idle, never reflected, 2 messages -> due.
      await db.repos.threads.create(thread(1, p1, { updatedAt: 3_000 }), [p1])
      await addMessages(testId('thr', 1), 2)
      // 2: idle, cursor equals lastSeq -> not due.
      await db.repos.threads.create(thread(2, p2, { updatedAt: 2_000 }), [p2])
      await addMessages(testId('thr', 2), 1)
      await db.repos.threads.setReflectedThrough(testId('thr', 2), 1)
      // 3: idle exactly at the cut-off, cursor behind -> due; oldest of the due ones.
      await db.repos.threads.create(thread(3, null, { kind: 'group', slug: null, updatedAt: 1_000 }), [
        p1,
        p2,
      ])
      await addMessages(testId('thr', 3), 3)
      await db.repos.threads.setReflectedThrough(testId('thr', 3), 1)
      // 4: active after the cut-off -> not due.
      await db.repos.threads.create(thread(4, null, { kind: 'group', slug: null, updatedAt: 9_000 }), [p1])
      await addMessages(testId('thr', 4), 2)
      // 5: idle but no messages -> not due.
      await db.repos.threads.create(thread(5, null, { kind: 'group', slug: null, updatedAt: 500 }), [p1])
      // 6: idle, same updated_at as 1 (tie broken by id).
      await db.repos.threads.create(thread(6, null, { kind: 'group', slug: null, updatedAt: 3_000 }), [p2])
      await addMessages(testId('thr', 6), 1)
      await db.repos.threads.touch(testId('thr', 3), idleBefore)
    })

    test('returns idle threads with messages past the cursor, oldest first, with lastSeq', async () => {
      const due = await db.repos.threads.listForReflection({ idleBefore, limit: 10 })
      expect(due.map((d) => [d.thread.id, d.lastSeq])).toEqual([
        [testId('thr', 1), 2],
        [testId('thr', 6), 1],
        [testId('thr', 3), 3],
      ])
      expect(due[2]?.thread).toMatchObject({
        reflectedThroughSeq: 1,
        summaryThroughSeq: null,
        updatedAt: idleBefore,
      })
    })

    test('caps the result by limit', async () => {
      const due = await db.repos.threads.listForReflection({ idleBefore, limit: 1 })
      expect(due.map((d) => d.thread.id)).toEqual([testId('thr', 1)])
      expect(await db.repos.threads.listForReflection({ idleBefore, limit: 0 })).toEqual([])
    })

    test('a thread whose cursor reaches lastSeq is no longer returned', async () => {
      await db.repos.threads.setReflectedThrough(testId('thr', 1), 2)
      const due = await db.repos.threads.listForReflection({ idleBefore, limit: 10 })
      expect(due.map((d) => d.thread.id)).toEqual([testId('thr', 6), testId('thr', 3)])
    })
  })
})

describe('participants (phase 5)', () => {
  const g = thread(1, null, { kind: 'group', slug: null, title: 'Trip', purpose: 'Plan the river trip' })
  beforeEach(async () => {
    await db.repos.persons.create(person(3))
    await db.repos.threads.create(g, [p1, p2])
  })

  test('create stores purpose, and get, getBySlug and listForPerson return it', async () => {
    expect((await db.repos.threads.get(g.id))?.purpose).toBe('Plan the river trip')
    expect((await db.repos.threads.listForPerson(p1)).map((t) => t.purpose)).toEqual(['Plan the river trip'])
    const d = thread(2, p1, { purpose: 'x' })
    await db.repos.threads.create(d, [p1])
    expect((await db.repos.threads.getBySlug(p1, 'main'))?.purpose).toBe('x')
  })

  test('add, remove, add again leaves one current row with the new joined_at', async () => {
    const p3 = testId('per', 3)
    expect(await db.repos.threads.addParticipant(g.id, p3, 3_000)).toBe(true)
    expect(await db.repos.threads.addParticipant(g.id, p3, 3_500)).toBe(false)
    expect(await db.repos.threads.removeParticipant(g.id, p3, 4_000)).toBe(true)
    expect(await db.repos.threads.removeParticipant(g.id, p3, 4_500)).toBe(false)
    expect(await db.repos.threads.addParticipant(g.id, p3, 5_000)).toBe(true)
    const rows = (await db.repos.threads.participants(g.id)).filter((r) => r.personId === p3)
    expect(rows).toEqual([{ threadId: g.id, personId: p3, joinedAt: 5_000, leftAt: null }])
    expect(await db.repos.threads.formerParticipants(g.id)).toEqual([])
  })

  test('removing someone who never joined changes nothing', async () => {
    expect(await db.repos.threads.removeParticipant(g.id, testId('per', 3), 4_000)).toBe(false)
  })

  test('listForPerson drops a thread the person left', async () => {
    expect((await db.repos.threads.listForPerson(p2)).map((t) => t.id)).toEqual([g.id])
    await db.repos.threads.removeParticipant(g.id, p2, 4_000)
    expect(await db.repos.threads.listForPerson(p2)).toEqual([])
    expect((await db.repos.threads.participants(g.id)).map((r) => r.personId)).toEqual([p1])
  })

  test('formerParticipants lists only people who left, most recent first', async () => {
    const p3 = testId('per', 3)
    await db.repos.threads.addParticipant(g.id, p3, 3_000)
    await db.repos.threads.removeParticipant(g.id, p2, 4_000)
    await db.repos.threads.removeParticipant(g.id, p3, 6_000)
    expect(await db.repos.threads.formerParticipants(g.id)).toEqual([
      { threadId: g.id, personId: p3, joinedAt: 3_000, leftAt: 6_000 },
      { threadId: g.id, personId: p2, joinedAt: g.createdAt, leftAt: 4_000 },
    ])
  })
})
