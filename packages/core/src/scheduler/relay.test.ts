// Tests for the relay service (scheduler/relay.ts): I-13 per ADR-0017, over the fake
// repositories and the real DeliveryQueue.

import { describe, expect, test } from 'bun:test'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { Delivery, NewDelivery, PersonId, Tier } from '../shared/types.ts'
import { createDeliveryQueue } from './deliveries.ts'
import { createRelayService } from './relay.ts'
import { createFakeEventBus, createFakeIds, createFakeRepos, seedPerson } from './testing/fakes.ts'

function setup() {
  const clock = createFakeClock(1_000_000)
  const ids = createFakeIds()
  const events = createFakeEventBus(clock)
  const repos = createFakeRepos()
  const queue = createDeliveryQueue({ repos, events, ids, clock })
  const enqueued: NewDelivery[] = []
  const deliveries = {
    enqueue: (d: NewDelivery): Promise<Delivery> => {
      enqueued.push(d)
      return queue.enqueue(d)
    },
  }
  const service = createRelayService({ repos, deliveries, log: createMemoryLogger() })
  const person = (name: string, tier: Tier) => seedPerson(repos, ids, { name, tier })
  return { repos, ids, events, enqueued, service, person }
}

describe('RelayService.send (I-13, ADR-0017)', () => {
  test('I-13: member relays to member', async () => {
    const w = setup()
    const rhodey = await w.person('Rhodey', 'member')
    const pepper = await w.person('Pepper', 'member')

    const result = await w.service.send({
      fromPersonId: rhodey.personId,
      toPersonId: pepper.personId,
      text: "I'll be late",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(w.enqueued).toEqual([
      {
        personId: pepper.personId,
        threadId: pepper.threadId,
        kind: 'relay',
        authorPersonId: rhodey.personId,
        source: 'core',
        urgency: 'normal',
        content: "I'll be late",
      },
    ])
    expect(result.delivery).toMatchObject({
      personId: pepper.personId,
      threadId: pepper.threadId,
      kind: 'relay',
      authorPersonId: rhodey.personId,
      status: 'pending',
      content: "I'll be late",
    })
    expect(w.repos.deliveryRows.get(result.delivery.id)?.kind).toBe('relay')
    expect(w.events.emitted.filter((e) => e.name === 'delivery.enqueued')).toHaveLength(1)
  })

  test('I-13: owner relays to member, member relays to owner', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    expect(
      (await w.service.send({ fromPersonId: tony.personId, toPersonId: pepper.personId, text: 'a' })).ok,
    ).toBe(true)
    expect(
      (await w.service.send({ fromPersonId: pepper.personId, toPersonId: tony.personId, text: 'b' })).ok,
    ).toBe(true)
  })

  test('I-13: guest may relay only to the owner', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    const happy = await w.person('Happy', 'guest')
    const peter = await w.person('Peter', 'guest')

    const toOwner = await w.service.send({
      fromPersonId: happy.personId,
      toPersonId: tony.personId,
      text: 'hi',
    })
    expect(toOwner.ok).toBe(true)
    if (toOwner.ok) expect(toOwner.delivery.threadId).toBe(tony.threadId)

    expect(
      await w.service.send({ fromPersonId: happy.personId, toPersonId: pepper.personId, text: 'hi' }),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    })
    expect(
      await w.service.send({ fromPersonId: happy.personId, toPersonId: peter.personId, text: 'hi' }),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    })
    expect(w.enqueued).toHaveLength(1)
  })

  test('I-13: a block refuses, even for the owner as sender', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    const rhodey = await w.person('Rhodey', 'member')
    expect(await w.service.block({ personId: pepper.personId, from: tony.personId })).toBe(true)

    expect(
      await w.service.send({ fromPersonId: tony.personId, toPersonId: pepper.personId, text: 'hi' }),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    })
    // Only the blocked sender is refused.
    expect(
      (await w.service.send({ fromPersonId: rhodey.personId, toPersonId: pepper.personId, text: 'hi' })).ok,
    ).toBe(true)
    expect(w.enqueued.map((d) => d.authorPersonId)).toEqual([rhodey.personId])
  })

  test('I-13: a block wins over the guest-to-owner rule', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const happy = await w.person('Happy', 'guest')
    await w.service.block({ personId: tony.personId, from: happy.personId })
    expect(
      await w.service.send({ fromPersonId: happy.personId, toPersonId: tony.personId, text: 'hi' }),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    })
  })

  test('I-13: nobody relays to themselves', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(
      await w.service.send({ fromPersonId: tony.personId, toPersonId: tony.personId, text: 'hi' }),
    ).toEqual({
      ok: false,
      reason: 'self',
    })
    expect(w.enqueued).toEqual([])
  })

  test('unknown_recipient: no such person', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(
      await w.service.send({
        fromPersonId: tony.personId,
        toPersonId: 'per_missing' as PersonId,
        text: 'hi',
      }),
    ).toEqual({ ok: false, reason: 'unknown_recipient' })
    expect(w.enqueued).toEqual([])
  })

  test('unknown_recipient: a person without a main thread', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepperId = w.ids.next('per') as PersonId
    await w.repos.persons.create({
      id: pepperId,
      name: 'Pepper',
      username: null,
      passwordHash: null,
      tier: 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
    expect(await w.service.send({ fromPersonId: tony.personId, toPersonId: pepperId, text: 'hi' })).toEqual({
      ok: false,
      reason: 'unknown_recipient',
    })
    expect(w.enqueued).toEqual([])
  })

  test('I-13: the text is kept verbatim', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    const text = "  I'll be late,\nsorry!  "
    const result = await w.service.send({ fromPersonId: tony.personId, toPersonId: pepper.personId, text })
    expect(result.ok && result.delivery.content).toBe(text)
  })
})

describe('RelayService.block / unblock', () => {
  test('I-13: block and unblock are idempotent and keep tone and notes', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await seedPerson(w.repos, w.ids, {
      name: 'Pepper',
      tier: 'member',
      tone: 'warm',
      notes: 'CEO',
    })
    const card = () => w.repos.relationships.get(pepper.personId)

    expect(await w.service.block({ personId: pepper.personId, from: tony.personId })).toBe(true)
    expect(await card()).toEqual({
      personId: pepper.personId,
      tone: 'warm',
      notes: 'CEO',
      blockedRelayFrom: [tony.personId],
    })
    expect(await w.service.block({ personId: pepper.personId, from: tony.personId })).toBe(false)
    expect((await card())?.blockedRelayFrom).toEqual([tony.personId])

    expect(await w.service.unblock({ personId: pepper.personId, from: tony.personId })).toBe(true)
    expect(await card()).toEqual({
      personId: pepper.personId,
      tone: 'warm',
      notes: 'CEO',
      blockedRelayFrom: [],
    })
    expect(await w.service.unblock({ personId: pepper.personId, from: tony.personId })).toBe(false)
  })

  test('I-13: an unchanged list is not written', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    let upserts = 0
    const upsert = w.repos.relationships.upsert
    w.repos.relationships.upsert = async (r) => {
      upserts++
      await upsert(r)
    }
    await w.service.unblock({ personId: pepper.personId, from: tony.personId })
    await w.service.block({ personId: pepper.personId, from: tony.personId })
    await w.service.block({ personId: pepper.personId, from: tony.personId })
    expect(upserts).toBe(1)
  })

  test('I-13: a missing card is created empty', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepperId = 'per_nocard' as PersonId
    expect(await w.service.unblock({ personId: pepperId, from: tony.personId })).toBe(false)
    expect(await w.repos.relationships.get(pepperId)).toBeNull()
    expect(await w.service.block({ personId: pepperId, from: tony.personId })).toBe(true)
    expect(await w.repos.relationships.get(pepperId)).toEqual({
      personId: pepperId,
      tone: '',
      notes: '',
      blockedRelayFrom: [tony.personId],
    })
  })

  test('I-13: blocking keeps other entries', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const rhodey = await w.person('Rhodey', 'member')
    const pepper = await w.person('Pepper', 'member')
    await w.service.block({ personId: pepper.personId, from: tony.personId })
    await w.service.block({ personId: pepper.personId, from: rhodey.personId })
    await w.service.unblock({ personId: pepper.personId, from: tony.personId })
    expect((await w.repos.relationships.get(pepper.personId))?.blockedRelayFrom).toEqual([rhodey.personId])
  })

  test('nobody blocks themselves', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(await w.service.block({ personId: tony.personId, from: tony.personId })).toBe(false)
    expect((await w.repos.relationships.get(tony.personId))?.blockedRelayFrom).toEqual([])
  })
})
