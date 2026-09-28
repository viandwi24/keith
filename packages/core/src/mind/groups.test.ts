// GroupThreads (P5-C1): start, invite, join and leave against fake repositories, delivery queue and
// bus built from their types.ts (ADR-0017).

import { describe, expect, test } from 'bun:test'
import { isKeithError } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { KeithConfig } from '../config/types.ts'
import type { PersonId, ThreadId, ThreadInvitation, Tier } from '../shared/types.ts'
import type { ThreadInvitationsRepository } from '../storage/types.ts'
import { createGroupThreads, INVITATION_ACTIONS_ID, invitationText } from './groups.ts'
import {
  createFakeBus,
  createFakeDeliveryQueue,
  createFakeIds,
  createFakeRepos,
  testConfig,
} from './testing/fakes.ts'
import type { GroupRefusalReason, GroupThreads } from './types.ts'

type FakeInvitations = ThreadInvitationsRepository & { rows: ThreadInvitation[] }

/** In-memory `ThreadInvitationsRepository`, following its JSDoc. */
function createFakeInvitations(): FakeInvitations {
  const rows: ThreadInvitation[] = []
  const find = (threadId: ThreadId, personId: PersonId) =>
    rows.findIndex((r) => r.threadId === threadId && r.personId === personId)
  return {
    rows,
    async create(inv) {
      const i = find(inv.threadId, inv.personId)
      const row = rows[i]
      if (row && row.status !== 'declined') return false
      if (row) rows[i] = { ...inv }
      else rows.push({ ...inv })
      return true
    },
    async get(threadId, personId) {
      return rows[find(threadId, personId)] ?? null
    },
    async pendingForThread(threadId) {
      return rows
        .filter((r) => r.threadId === threadId && r.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt || a.personId.localeCompare(b.personId))
    },
    async pendingForPerson(personId) {
      return rows
        .filter((r) => r.personId === personId && r.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId))
    },
    async resolve(threadId, personId, status, at) {
      const i = find(threadId, personId)
      const row = rows[i]
      if (row?.status !== 'pending') return false
      rows[i] = { ...row, status, resolvedAt: at }
      return true
    },
  }
}

async function world(group: Partial<KeithConfig['mind']['group']> = {}) {
  const clock = createFakeClock(1_000)
  const ids = createFakeIds()
  const bus = createFakeBus(clock)
  const repos = createFakeRepos()
  const invitations = createFakeInvitations()
  const mains = new Map<PersonId, ThreadId>()
  const deliveries = createFakeDeliveryQueue({
    ids,
    clock,
    bus,
    mainThreadOf: (personId) => {
      const t = mains.get(personId)
      if (!t) throw new Error(`no main thread for ${personId}`)
      return t
    },
  })
  const base = testConfig().mind
  const config = { mind: { ...base, group: { ...base.group, ...group } } }
  const groups = createGroupThreads({
    config,
    repos: { persons: repos.persons, threads: repos.threads, threadInvitations: invitations },
    deliveries,
    events: bus,
    ids,
    clock,
    log: createMemoryLogger(),
  })

  async function person(name: string, tier: Tier): Promise<PersonId> {
    const id = ids.next('per')
    await repos.persons.create({
      id,
      name,
      username: name.toLowerCase(),
      passwordHash: null,
      tier,
      lastSeenAt: null,
      createdAt: 0,
    })
    const main = ids.next('thr')
    await repos.threads.create(
      {
        id: main,
        kind: 'direct',
        slug: 'main',
        title: 'Main',
        ownerPersonId: id,
        summary: null,
        createdAt: 0,
        updatedAt: 0,
      },
      [id],
    )
    mains.set(id, main)
    return id
  }

  const tony = await person('Tony', 'owner')
  const pepper = await person('Pepper', 'member')
  const rhodey = await person('Rhodey', 'member')
  const happy = await person('Happy', 'guest')

  const participantIds = async (threadId: ThreadId) =>
    (await repos.threads.participants(threadId)).map((p) => p.personId)

  return {
    clock,
    bus,
    repos,
    invitations,
    deliveries,
    groups,
    mains,
    person,
    participantIds,
    tony,
    pepper,
    rhodey,
    happy,
  }
}

async function refusalOf(p: Promise<unknown>): Promise<GroupRefusalReason | undefined> {
  try {
    await p
  } catch (error) {
    if (isKeithError(error, 'FORBIDDEN')) return error.details?.reason as GroupRefusalReason
    throw error
  }
  throw new Error('expected a refusal')
}

async function startMission(w: Awaited<ReturnType<typeof world>>, groups: GroupThreads = w.groups) {
  return groups.start({
    creatorId: w.tony,
    inviteeIds: [w.pepper, w.rhodey],
    title: 'Mission',
    purpose: 'Plan the extraction',
  })
}

describe('start', () => {
  test('creates the group with the creator only, invites the others with Join/Decline cards', async () => {
    const w = await world()
    const r = await startMission(w)

    expect(r.thread).toMatchObject({
      kind: 'group',
      slug: null,
      title: 'Mission',
      purpose: 'Plan the extraction',
      ownerPersonId: w.tony,
    })
    expect(await w.repos.threads.get(r.thread.id)).not.toBeNull()
    expect(await w.participantIds(r.thread.id)).toEqual([w.tony])
    expect(r.invited).toEqual([w.pepper, w.rhodey])
    expect(r.joined).toEqual([])

    expect(w.bus.named('thread.participant_joined')).toEqual([
      { threadId: r.thread.id, personId: w.tony, invitedBy: null },
    ])

    for (const invitee of [w.pepper, w.rhodey]) {
      const inv = await w.invitations.get(r.thread.id, invitee)
      expect(inv).toMatchObject({ status: 'pending', invitedBy: w.tony, resolvedAt: null })
      const delivery = w.deliveries.all.find((d) => d.personId === invitee)
      expect(delivery).toMatchObject({
        kind: 'invitation',
        threadId: w.mains.get(invitee),
        authorPersonId: w.tony,
        urgency: 'normal',
      })
      expect(inv?.deliveryId).toBe(delivery?.id ?? null)
      expect(delivery?.content).toBe(
        `Tony invites you to the group thread "Mission" (${r.thread.id}): Plan the extraction. ` +
          'Say whether you want to join.',
      )
      const card = delivery?.ui
      if (card?.type !== 'card') throw new Error('expected a card')
      expect(card.body).toBe(delivery?.content)
      const actions = card.children?.[0]
      if (actions?.type !== 'actions') throw new Error('expected an actions block')
      expect(actions.id).toBe(INVITATION_ACTIONS_ID)
      expect(actions.actions.map((a) => a.label)).toEqual(['Join', 'Decline'])
    }
  })

  test('a group without a purpose leaves it out of the invitation', () => {
    expect(
      invitationText({
        inviterName: 'Tony',
        thread: { id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31', title: 'Mission', purpose: null },
        joined: false,
      }),
    ).toBe(
      'Tony invites you to the group thread "Mission" (thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31). Say whether you want to join.',
    )
  })

  test('refuses a guest creator, an empty, self-including or unknown list, and too many invitees', async () => {
    const w = await world({ maxParticipants: 3 })
    const start = (creatorId: PersonId, inviteeIds: PersonId[]) =>
      w.groups.start({ creatorId, inviteeIds, title: 'Mission', purpose: null })

    expect(await refusalOf(start(w.happy, [w.tony]))).toBe('tier')
    expect(await refusalOf(start(w.tony, []))).toBe('no_invitees')
    expect(await refusalOf(start(w.tony, [w.pepper, w.tony]))).toBe('self')
    expect(await refusalOf(start(w.tony, [w.pepper, 'per_09999999999999999999999999']))).toBe(
      'unknown_person',
    )
    expect(await refusalOf(start(w.tony, [w.pepper, w.rhodey, w.happy]))).toBe('limit')
    // Nothing was created.
    expect(w.repos.all.threads.filter((t) => t.kind === 'group')).toEqual([])
    expect(w.deliveries.all).toEqual([])
    expect(w.bus.emitted.filter((e) => e.name.startsWith('thread.'))).toEqual([])

    // Exactly maxParticipants − 1 invitees is allowed.
    const ok = await start(w.tony, [w.pepper, w.rhodey])
    expect(ok.invited).toHaveLength(2)
  })
})

describe('invite', () => {
  test('only a member participant of a group invites; the already invited are skipped', async () => {
    const w = await world()
    const { thread } = await startMission(w)

    // Rhodey is invited, not a participant yet.
    expect(
      await refusalOf(w.groups.invite({ threadId: thread.id, inviterId: w.rhodey, inviteeIds: [w.happy] })),
    ).toBe('not_participant')
    // A direct thread is not a group.
    expect(
      await refusalOf(
        w.groups.invite({
          threadId: w.mains.get(w.tony) as ThreadId,
          inviterId: w.tony,
          inviteeIds: [w.pepper],
        }),
      ),
    ).toBe('not_group')

    const r = await w.groups.invite({
      threadId: thread.id,
      inviterId: w.tony,
      inviteeIds: [w.pepper, w.happy],
    })
    expect(r).toEqual({ invited: [w.happy], joined: [], skipped: [w.pepper] })
    expect(w.deliveries.all.filter((d) => d.personId === w.pepper)).toHaveLength(1)
  })

  test('a guest participant is refused', async () => {
    const w = await world()
    const { thread } = await w.groups.start({
      creatorId: w.tony,
      inviteeIds: [w.happy],
      title: 'Kids',
      purpose: null,
    })
    expect(await w.groups.join({ threadId: thread.id, personId: w.happy })).toBe(true)
    expect(
      await refusalOf(w.groups.invite({ threadId: thread.id, inviterId: w.happy, inviteeIds: [w.pepper] })),
    ).toBe('tier')
  })

  test('the limit counts current participants plus pending invitations', async () => {
    const w = await world({ maxParticipants: 4 })
    const { thread } = await startMission(w) // Tony + 2 pending = 3
    const extra = await w.person('Natasha', 'member')
    expect(
      await refusalOf(
        w.groups.invite({ threadId: thread.id, inviterId: w.tony, inviteeIds: [w.happy, extra] }),
      ),
    ).toBe('limit')
    const r = await w.groups.invite({ threadId: thread.id, inviterId: w.tony, inviteeIds: [w.happy] })
    expect(r.invited).toEqual([w.happy])
  })

  test('an unknown thread is NOT_FOUND', async () => {
    const w = await world()
    await expect(
      w.groups.invite({
        threadId: 'thr_09999999999999999999999999',
        inviterId: w.tony,
        inviteeIds: [w.pepper],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('join', () => {
  test('without an invitation it is false; with one it adds the participant and emits invitedBy', async () => {
    const w = await world()
    const { thread } = await startMission(w)

    expect(await w.groups.join({ threadId: thread.id, personId: w.happy })).toBe(false)
    expect(await w.participantIds(thread.id)).toEqual([w.tony])

    w.clock.advance(500)
    expect(await w.groups.join({ threadId: thread.id, personId: w.pepper })).toBe(true)
    expect(await w.participantIds(thread.id)).toEqual([w.tony, w.pepper])
    expect(await w.invitations.get(thread.id, w.pepper)).toMatchObject({
      status: 'accepted',
      resolvedAt: 1_500,
    })
    expect(w.bus.named('thread.participant_joined').at(-1)).toEqual({
      threadId: thread.id,
      personId: w.pepper,
      invitedBy: w.tony,
    })

    // A second join has no pending invitation any more.
    expect(await w.groups.join({ threadId: thread.id, personId: w.pepper })).toBe(false)
    expect(w.bus.named('thread.participant_joined')).toHaveLength(2)
  })
})

describe('leave', () => {
  test('a participant leaves and thread.participant_left is emitted', async () => {
    const w = await world()
    const { thread } = await startMission(w)
    await w.groups.join({ threadId: thread.id, personId: w.pepper })

    expect(await w.groups.leave({ threadId: thread.id, personId: w.pepper })).toBe(true)
    expect(await w.participantIds(thread.id)).toEqual([w.tony])
    expect(w.bus.named('thread.participant_left')).toEqual([{ threadId: thread.id, personId: w.pepper }])
    expect((await w.repos.threads.listForPerson(w.pepper)).map((t) => t.id)).not.toContain(thread.id)
  })

  test('a pending invitation is declined without an event, and a re-invite then works', async () => {
    const w = await world()
    const { thread } = await startMission(w)

    expect(await w.groups.leave({ threadId: thread.id, personId: w.rhodey })).toBe(true)
    expect(await w.invitations.get(thread.id, w.rhodey)).toMatchObject({ status: 'declined' })
    expect(w.bus.named('thread.participant_left')).toEqual([])

    const r = await w.groups.invite({ threadId: thread.id, inviterId: w.tony, inviteeIds: [w.rhodey] })
    expect(r.invited).toEqual([w.rhodey])
    expect(await w.invitations.get(thread.id, w.rhodey)).toMatchObject({ status: 'pending' })
    expect(await w.groups.join({ threadId: thread.id, personId: w.rhodey })).toBe(true)
  })

  test('a former participant is skipped on a new invite (the accepted row cannot be replaced)', async () => {
    const w = await world()
    const { thread } = await startMission(w)
    await w.groups.join({ threadId: thread.id, personId: w.pepper })
    await w.groups.leave({ threadId: thread.id, personId: w.pepper })
    const sent = w.deliveries.all.length
    const r = await w.groups.invite({ threadId: thread.id, inviterId: w.tony, inviteeIds: [w.pepper] })
    expect(r).toEqual({ invited: [], joined: [], skipped: [w.pepper] })
    expect(w.deliveries.all).toHaveLength(sent)
  })

  test('neither participant nor invited is false; a direct thread is refused', async () => {
    const w = await world()
    const { thread } = await startMission(w)
    expect(await w.groups.leave({ threadId: thread.id, personId: w.happy })).toBe(false)
    expect(
      await refusalOf(w.groups.leave({ threadId: w.mains.get(w.tony) as ThreadId, personId: w.tony })),
    ).toBe('not_group')
  })
})

describe('autoJoin', () => {
  test('joins a member at once with a notice without buttons, but never a guest', async () => {
    const w = await world({ autoJoin: true })
    const r = await w.groups.start({
      creatorId: w.tony,
      inviteeIds: [w.pepper, w.happy],
      title: 'Mission',
      purpose: null,
    })
    expect(r.joined).toEqual([w.pepper])
    expect(r.invited).toEqual([w.happy])
    expect(await w.participantIds(r.thread.id)).toEqual([w.tony, w.pepper])
    expect(w.bus.named('thread.participant_joined')).toEqual([
      { threadId: r.thread.id, personId: w.tony, invitedBy: null },
      { threadId: r.thread.id, personId: w.pepper, invitedBy: w.tony },
    ])

    const notice = w.deliveries.all.find((d) => d.personId === w.pepper)
    expect(notice?.content).toBe(
      `Tony added you to the group thread "Mission" (${r.thread.id}). It is in your thread list.`,
    )
    expect(notice?.ui?.type === 'card' && notice.ui.children).toBeFalsy()
    expect(await w.invitations.get(r.thread.id, w.pepper)).toMatchObject({ status: 'accepted' })

    const guestInvite = w.deliveries.all.find((d) => d.personId === w.happy)
    expect(guestInvite?.ui?.type === 'card' && guestInvite.ui.children?.length).toBe(1)
    expect(await w.invitations.get(r.thread.id, w.happy)).toMatchObject({ status: 'pending' })
  })
})
