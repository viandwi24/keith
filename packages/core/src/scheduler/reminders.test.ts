// Tests for the reminder service (scheduler/reminders.ts): the real DeliveryQueue over fakes.

import { describe, expect, test } from 'bun:test'
import { isKeithError } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { KeithConfig } from '../config/types.ts'
import type { PersonId, ReminderId, ThreadId } from '../shared/types.ts'
import { createDeliveryQueue } from './deliveries.ts'
import { createReminderService } from './reminders.ts'
import {
  createFakeEventBus,
  createFakeIds,
  createFakeRepos,
  createTestConfig,
  seedPerson,
} from './testing/fakes.ts'
import { createHarness } from './testing/harness.ts'
import type { DeliveryQueue } from './types.ts'

const MINUTE = 60_000

function setup(opts: { maxPerPerson?: number; deliveries?: Pick<DeliveryQueue, 'enqueue'> } = {}) {
  const config: KeithConfig = createTestConfig()
  if (opts.maxPerPerson !== undefined) config.mind.reminder = { maxPerPerson: opts.maxPerPerson }
  const clock = createFakeClock(1_000_000)
  const ids = createFakeIds()
  const events = createFakeEventBus(clock)
  const repos = createFakeRepos()
  const log = createMemoryLogger()
  const queue = createDeliveryQueue({ repos, events, ids, clock })
  const build = (deliveries: Pick<DeliveryQueue, 'enqueue'> = opts.deliveries ?? queue) =>
    createReminderService({ config, repos, deliveries, ids, clock, log })
  return { config, clock, ids, events, repos, log, queue, service: build(), build }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('ReminderService.set / listFor / cancel', () => {
  test('set stores a trimmed pending reminder with a rem id', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const r = await s.service.set({
      personId: tony.personId,
      threadId: tony.threadId,
      text: '  Call Pepper  ',
      dueAt: s.clock.now() + MINUTE,
    })
    expect(r.id.startsWith('rem_')).toBe(true)
    expect(r).toMatchObject({
      personId: tony.personId,
      threadId: tony.threadId,
      text: 'Call Pepper',
      status: 'pending',
      createdAt: s.clock.now(),
      firedAt: null,
      cancelledAt: null,
      deliveryId: null,
    })
    expect(s.repos.reminderRows.get(r.id)).toEqual(r)
  })

  test('set refuses empty or too long text', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const base = { personId: tony.personId, threadId: null, dueAt: s.clock.now() + MINUTE }
    expect(isKeithError(await rejection(s.service.set({ ...base, text: '   ' })), 'TOOL_INPUT_INVALID')).toBe(
      true,
    )
    const long = await rejection(s.service.set({ ...base, text: 'x'.repeat(501) }))
    expect(isKeithError(long, 'TOOL_INPUT_INVALID')).toBe(true)
    expect(s.repos.reminderRows.size).toBe(0)
  })

  test('the limit gives an error at maxPerPerson, per person, and frees up after a cancel', async () => {
    const s = setup({ maxPerPerson: 2 })
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const pepper = await seedPerson(s.repos, s.ids, { name: 'Pepper' })
    const add = (personId: PersonId, text: string) =>
      s.service.set({ personId, threadId: null, text, dueAt: s.clock.now() + MINUTE })
    const first = await add(tony.personId, 'one')
    await add(tony.personId, 'two')
    const error = await rejection(add(tony.personId, 'three'))
    expect(isKeithError(error, 'FORBIDDEN')).toBe(true)
    expect(isKeithError(error) && error.details).toEqual({ limit: 2 })
    // Concurrent sets can't slip past the check.
    const racing = await Promise.allSettled([
      add(pepper.personId, 'a'),
      add(pepper.personId, 'b'),
      add(pepper.personId, 'c'),
    ])
    expect(racing.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(await s.service.cancel({ id: first.id, personId: tony.personId })).toBe(true)
    await add(tony.personId, 'three')
    expect(await s.repos.reminders.countPending(tony.personId)).toBe(2)
  })

  test('listFor returns pending reminders only, soonest first', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const add = (text: string, inMin: number) =>
      s.service.set({ personId: tony.personId, threadId: null, text, dueAt: s.clock.now() + inMin * MINUTE })
    await add('later', 30)
    const cancelled = await add('cancelled', 5)
    await add('sooner', 10)
    await s.service.cancel({ id: cancelled.id, personId: tony.personId })
    expect((await s.service.listFor(tony.personId)).map((r) => r.text)).toEqual(['sooner', 'later'])
  })

  test("cancel refuses someone else's reminder, an unknown id, and one not pending", async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const pepper = await seedPerson(s.repos, s.ids, { name: 'Pepper' })
    const r = await s.service.set({
      personId: tony.personId,
      threadId: null,
      text: 'Call Pepper',
      dueAt: s.clock.now() + MINUTE,
    })
    expect(await s.service.cancel({ id: r.id, personId: pepper.personId })).toBe(false)
    expect(s.repos.reminderRows.get(r.id)?.status).toBe('pending')
    expect(await s.service.cancel({ id: s.ids.next('rem') as ReminderId, personId: tony.personId })).toBe(
      false,
    )
    s.clock.advance(1_000)
    expect(await s.service.cancel({ id: r.id, personId: tony.personId })).toBe(true)
    expect(s.repos.reminderRows.get(r.id)).toMatchObject({ status: 'cancelled', cancelledAt: s.clock.now() })
    expect(await s.service.cancel({ id: r.id, personId: tony.personId })).toBe(false)
  })
})

describe('ReminderService.fireDue', () => {
  test('enqueues one reminder delivery per due reminder, in due order, and marks each fired', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const pepper = await seedPerson(s.repos, s.ids, { name: 'Pepper' })
    const t0 = s.clock.now()
    const b = await s.service.set({
      personId: tony.personId,
      threadId: tony.threadId,
      text: 'b',
      dueAt: t0 + 2 * MINUTE,
    })
    const a = await s.service.set({
      personId: pepper.personId,
      threadId: null,
      text: 'a',
      dueAt: t0 + MINUTE,
    })
    const future = await s.service.set({
      personId: tony.personId,
      threadId: null,
      text: 'c',
      dueAt: t0 + 60 * MINUTE,
    })

    const now = t0 + 5 * MINUTE
    expect(await s.service.fireDue(now)).toBe(2)

    const enqueued = s.events.of('delivery.enqueued')
    expect(enqueued.map((e) => e.kind)).toEqual(['reminder', 'reminder'])
    expect(enqueued.map((e) => e.urgency)).toEqual(['high', 'high'])
    const deliveries = enqueued.map((e) => s.repos.deliveryRows.get(e.deliveryId))
    expect(deliveries.map((d) => d?.content)).toEqual(['a', 'b'])
    // A reminder without a thread goes to the person's main thread.
    expect(deliveries[0]).toMatchObject({
      personId: pepper.personId,
      threadId: pepper.threadId,
      source: 'core',
    })
    expect(deliveries[1]).toMatchObject({ personId: tony.personId, threadId: tony.threadId, source: 'core' })

    expect(s.repos.reminderRows.get(a.id)).toMatchObject({
      status: 'fired',
      firedAt: now,
      deliveryId: enqueued[0]?.deliveryId,
    })
    expect(s.repos.reminderRows.get(b.id)).toMatchObject({
      status: 'fired',
      firedAt: now,
      deliveryId: enqueued[1]?.deliveryId,
    })
    // Future reminders stay pending.
    expect(s.repos.reminderRows.get(future.id)?.status).toBe('pending')

    // A second call fires nothing.
    expect(await s.service.fireDue(now)).toBe(0)
    expect(s.events.of('delivery.enqueued')).toHaveLength(2)
  })

  test('a failed enqueue keeps the reminder pending, and it fires on the next call', async () => {
    const s = setup()
    // A person with no main thread yet: the real queue fails with NOT_FOUND.
    const personId = s.ids.next('per')
    const r = await s.service.set({ personId, threadId: null, text: 'Call Pepper', dueAt: s.clock.now() })
    expect(await s.service.fireDue(s.clock.now())).toBe(0)
    expect(s.repos.reminderRows.get(r.id)?.status).toBe('pending')
    expect(s.log.entries.some((e) => e.level === 'warn' && e.fields?.reminderId === r.id)).toBe(true)

    // The thread appears; the next tick fires it.
    const threadId = s.ids.next('thr') as ThreadId
    await s.repos.threads.create(
      {
        id: threadId,
        kind: 'direct',
        slug: 'main',
        title: 'Main',
        ownerPersonId: personId,
        summary: null,
        createdAt: 0,
        updatedAt: 0,
      },
      [personId],
    )
    s.clock.advance(30_000)
    expect(await s.service.fireDue(s.clock.now())).toBe(1)
    expect(s.repos.reminderRows.get(r.id)?.status).toBe('fired')
    expect(s.events.of('delivery.enqueued')[0]?.threadId).toBe(threadId)
  })

  test('one failing enqueue does not hold back the others', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    const ghost = s.ids.next('per')
    await s.service.set({ personId: ghost, threadId: null, text: 'first', dueAt: s.clock.now() })
    await s.service.set({ personId: tony.personId, threadId: null, text: 'second', dueAt: s.clock.now() + 1 })
    expect(await s.service.fireDue(s.clock.now() + 1)).toBe(1)
    expect(s.events.of('delivery.enqueued').map((e) => e.threadId)).toEqual([tony.threadId])
  })

  test('overlapping calls are serialized and fire each reminder once', async () => {
    const s = setup()
    const tony = await seedPerson(s.repos, s.ids, { name: 'Tony' })
    await s.service.set({ personId: tony.personId, threadId: null, text: 'once', dueAt: s.clock.now() })
    const counts = await Promise.all([s.service.fireDue(s.clock.now()), s.service.fireDue(s.clock.now())])
    expect(counts).toEqual([1, 0])
    expect(s.events.of('delivery.enqueued')).toHaveLength(1)
  })

  test('restart: a reminder due while the core was down fires on the first tick after start', async () => {
    const first = createHarness()
    const tony = await seedPerson(first.repos, first.ids, { name: 'Tony' })
    const r = await first.reminders.set({
      personId: tony.personId,
      threadId: tony.threadId,
      text: 'Call Pepper',
      dueAt: first.clock.now() + 10 * MINUTE,
    })
    // Down for an hour: a fresh scheduling (and service) over the same repos.
    const second = createHarness({ repos: first.repos, ids: first.ids })
    second.clock.advance(60 * MINUTE)
    await second.start()
    try {
      second.events.emit('scheduler.ticked', { at: second.clock.now() })
      await second.events.idle()
      expect(first.repos.reminderRows.get(r.id)).toMatchObject({
        status: 'fired',
        firedAt: second.clock.now(),
      })
      expect(second.events.of('delivery.enqueued')).toEqual([
        expect.objectContaining({ kind: 'reminder', threadId: tony.threadId, urgency: 'high' }),
      ])
    } finally {
      await second.stop()
    }
  })
})
