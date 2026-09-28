import { describe, expect, test } from 'bun:test'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb, markParticipantLeft } from './testing.ts'

describe('markParticipantLeft (phase-5 test helper)', () => {
  test('marks a current participant as left, so reads leave them out', async () => {
    using db = createTestDb()
    const tony = person(1)
    const pepper = person(2)
    await db.repos.persons.create(tony)
    await db.repos.persons.create(pepper)
    const group = thread(10, tony.id, { kind: 'group', slug: null, title: 'Mission' })
    await db.repos.threads.create(group, [tony.id, pepper.id])

    expect(markParticipantLeft(db, group.id, pepper.id, 5_000)).toBe(true)
    expect((await db.repos.threads.participants(group.id)).map((p) => p.personId)).toEqual([tony.id])
    expect((await db.repos.threads.listForPerson(pepper.id)).map((t) => t.id)).toEqual([])

    // Already left, or never a participant: nothing changes.
    expect(markParticipantLeft(db, group.id, pepper.id, 6_000)).toBe(false)
    expect(markParticipantLeft(db, group.id, testId('per', 9), 6_000)).toBe(false)
  })
})
