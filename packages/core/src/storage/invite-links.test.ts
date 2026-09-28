import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { person, testId } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { InviteLinkRecord } from './types.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await db.repos.persons.create(person(1, { tier: 'owner' }))
  await db.repos.persons.create(person(2, { username: null }))
  await db.repos.persons.create(person(3, { username: null }))
})
afterEach(() => db.close())

const p2 = testId('per', 2)
const p3 = testId('per', 3)

function link(n: number, personId = p2, patch: Partial<InviteLinkRecord> = {}): InviteLinkRecord {
  return {
    codeHash: `hash${n}`,
    personId,
    createdAt: 1_000 + n,
    expiresAt: 9_000 + n,
    usedAt: null,
    ...patch,
  }
}

describe('invite links (phase 5)', () => {
  test('round-trips a link; an unknown hash is null', async () => {
    await db.repos.inviteLinks.create(link(1))
    expect(await db.repos.inviteLinks.get('hash1')).toEqual(link(1))
    expect(await db.repos.inviteLinks.get('nope')).toBeNull()
  })

  test('markUsed wins once: a second call returns false and keeps the first time', async () => {
    await db.repos.inviteLinks.create(link(1))
    expect(await db.repos.inviteLinks.markUsed('hash1', 5_000)).toBe(true)
    expect(await db.repos.inviteLinks.markUsed('hash1', 6_000)).toBe(false)
    expect((await db.repos.inviteLinks.get('hash1'))?.usedAt).toBe(5_000)
    expect(await db.repos.inviteLinks.markUsed('nope', 6_000)).toBe(false)
  })

  test("revokeFor deletes only the person's unused links", async () => {
    await db.repos.inviteLinks.create(link(1))
    await db.repos.inviteLinks.create(link(2))
    await db.repos.inviteLinks.create(link(3, p2, { usedAt: 4_000 }))
    await db.repos.inviteLinks.create(link(4, p3))
    expect(await db.repos.inviteLinks.revokeFor(p2)).toBe(2)
    expect(await db.repos.inviteLinks.get('hash1')).toBeNull()
    expect(await db.repos.inviteLinks.get('hash2')).toBeNull()
    expect(await db.repos.inviteLinks.get('hash3')).toEqual(link(3, p2, { usedAt: 4_000 }))
    expect(await db.repos.inviteLinks.get('hash4')).toEqual(link(4, p3))
    expect(await db.repos.inviteLinks.revokeFor(p2)).toBe(0)
  })

  test('deleting the person cascades to their links', async () => {
    await db.repos.inviteLinks.create(link(1))
    await db.repos.inviteLinks.create(link(2, p2, { usedAt: 4_000 }))
    await db.repos.inviteLinks.create(link(3, p3))
    const removal = await db.repos.persons.remove(p2)
    expect(removal.deleted.inviteLinks).toBe(2)
    expect(await db.repos.inviteLinks.get('hash1')).toBeNull()
    expect(await db.repos.inviteLinks.get('hash2')).toBeNull()
    expect(await db.repos.inviteLinks.get('hash3')).not.toBeNull()
  })

  test('a link for an unknown person is refused (foreign key)', async () => {
    await expect(db.repos.inviteLinks.create(link(1, testId('per', 9)))).rejects.toThrow()
  })
})
