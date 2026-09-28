import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PersonId, ThreadId, ThreadInvitation } from '../shared/types.ts'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'

let db: TestDb
const p1 = testId('per', 1)
const p2 = testId('per', 2)
const p3 = testId('per', 3)
const g1 = testId('thr', 1)
const g2 = testId('thr', 2)

beforeEach(async () => {
  db = createTestDb()
  for (const n of [1, 2, 3]) await db.repos.persons.create(person(n))
  await db.repos.threads.create(thread(1, p1, { kind: 'group', slug: null }), [p1])
  await db.repos.threads.create(thread(2, p1, { kind: 'group', slug: null }), [p1])
})
afterEach(() => db.close())

function invitation(
  threadId: ThreadId,
  personId: PersonId,
  patch: Partial<ThreadInvitation> = {},
): ThreadInvitation {
  return {
    threadId,
    personId,
    invitedBy: p1,
    status: 'pending',
    deliveryId: null,
    createdAt: 3_000,
    resolvedAt: null,
    ...patch,
  }
}

describe('thread invitations (phase 5)', () => {
  test('create and get round-trip; an unknown pair is null', async () => {
    expect(await db.repos.threadInvitations.create(invitation(g1, p2))).toBe(true)
    expect(await db.repos.threadInvitations.get(g1, p2)).toEqual(invitation(g1, p2))
    expect(await db.repos.threadInvitations.get(g1, p3)).toBeNull()
  })

  test('create refuses while pending or accepted', async () => {
    await db.repos.threadInvitations.create(invitation(g1, p2))
    expect(
      await db.repos.threadInvitations.create(invitation(g1, p2, { invitedBy: p3, createdAt: 4_000 })),
    ).toBe(false)
    expect(await db.repos.threadInvitations.get(g1, p2)).toEqual(invitation(g1, p2))
    await db.repos.threadInvitations.resolve(g1, p2, 'accepted', 5_000)
    expect(await db.repos.threadInvitations.create(invitation(g1, p2, { createdAt: 6_000 }))).toBe(false)
    expect(await db.repos.threadInvitations.get(g1, p2)).toMatchObject({
      status: 'accepted',
      resolvedAt: 5_000,
    })
  })

  test('create re-invites after declined, replacing the row', async () => {
    await db.repos.threadInvitations.create(invitation(g1, p2))
    await db.repos.threadInvitations.resolve(g1, p2, 'declined', 4_000)
    const again = invitation(g1, p2, { invitedBy: p3, createdAt: 6_000 })
    expect(await db.repos.threadInvitations.create(again)).toBe(true)
    expect(await db.repos.threadInvitations.get(g1, p2)).toEqual(again)
  })

  test('resolve changes only a pending invitation', async () => {
    await db.repos.threadInvitations.create(invitation(g1, p2))
    expect(await db.repos.threadInvitations.resolve(g1, p2, 'accepted', 4_000)).toBe(true)
    expect(await db.repos.threadInvitations.resolve(g1, p2, 'declined', 5_000)).toBe(false)
    expect(await db.repos.threadInvitations.get(g1, p2)).toMatchObject({
      status: 'accepted',
      resolvedAt: 4_000,
    })
    expect(await db.repos.threadInvitations.resolve(g1, p3, 'declined', 5_000)).toBe(false)
  })

  test('pendingForThread and pendingForPerson: pending only, oldest first, ties by the other id', async () => {
    await db.repos.threadInvitations.create(invitation(g1, p3, { createdAt: 3_000 }))
    await db.repos.threadInvitations.create(invitation(g1, p2, { createdAt: 3_000 }))
    await db.repos.threadInvitations.create(invitation(g2, p2, { createdAt: 2_000 }))
    await db.repos.threadInvitations.create(invitation(g2, p3, { createdAt: 1_000 }))
    await db.repos.threadInvitations.resolve(g2, p3, 'declined', 4_000)
    expect((await db.repos.threadInvitations.pendingForThread(g1)).map((i) => i.personId)).toEqual([p2, p3])
    expect((await db.repos.threadInvitations.pendingForThread(g2)).map((i) => i.personId)).toEqual([p2])
    expect((await db.repos.threadInvitations.pendingForPerson(p2)).map((i) => i.threadId)).toEqual([g2, g1])
    expect((await db.repos.threadInvitations.pendingForPerson(p3)).map((i) => i.threadId)).toEqual([g1])
  })

  test('deleting its delivery sets delivery_id to null', async () => {
    const deliveryId = testId('dlv', 1)
    await db.repos.threads.create(thread(3, p2), [p2])
    await db.repos.deliveries.create({
      id: deliveryId,
      threadId: testId('thr', 3),
      personId: p2,
      kind: 'invitation',
      authorPersonId: p1,
      source: 'core',
      urgency: 'normal',
      content: 'Join?',
      ui: null,
      status: 'pending',
      createdAt: 3_000,
      deliveredAt: null,
    })
    await db.repos.threadInvitations.create(invitation(g1, p2, { deliveryId }))
    // Removing the invitee deletes the deliveries addressed to them and their invitations.
    await db.repos.threadInvitations.create(invitation(g1, p3, { deliveryId }))
    await db.repos.persons.remove(p2)
    expect(await db.repos.threadInvitations.get(g1, p3)).toMatchObject({ deliveryId: null })
    expect(await db.repos.threadInvitations.get(g1, p2)).toBeNull()
  })
})
