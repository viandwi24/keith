import { describe, expect, test } from 'bun:test'
import { deliveriesRepo, migrateDatabase, openDatabase } from '@keith/db'
import type { WakeRequest } from '@keith/host'
import type { HarnessAgent } from 'eharness'
import { createDelivery, createFrontRoute, singleRoutePlanner } from '../delivery/index.ts'
import { createWake } from './wake.ts'

interface Inject {
  session: string
  options: Record<string, unknown>
}

/** A lead agent that records the injects it was asked for; `down` makes it unavailable (no lead yet). */
function lead() {
  const injected: Inject[] = []
  const state = { down: false }
  const agent = {
    session: (id: string, options: Record<string, unknown>) => ({
      inject: async (_name: string, _payload: unknown, injectOptions: Record<string, unknown>) =>
        void injected.push({ session: id, options: { ...options, ...injectOptions } }),
    }),
  } as unknown as HarnessAgent
  return { agent, injected, state }
}

const request = (to: string, billTo?: string, extra: Partial<WakeRequest> = {}): WakeRequest => ({
  to,
  ...(billTo === undefined ? {} : { billTo }),
  name: 'reminder',
  text: 'pay the rent',
  id: 'fire-1',
  ...extra,
})

function setup(
  options: {
    isActive?: (id: string) => boolean
    remainingUsd?: (id: string) => number | null
    retryMs?: readonly number[]
  } = {},
) {
  const l = lead()
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { now: 1_000 }
  const deliveries = deliveriesRepo(sqlite, { now: () => clock.now })
  const delivery = createDelivery({
    generations: { current: () => 0 },
    deliveries,
    planner: singleRoutePlanner(
      createFrontRoute({
        generations: { current: () => 0 },
        lead: () => (l.state.down ? undefined : l.agent),
        lock: {} as never,
        remainingUsd: options.remainingUsd ?? (() => null),
        warn: () => {},
      }),
    ),
    audit: { record: () => {} },
    isActive: options.isActive ?? (() => true),
    now: () => clock.now,
    retryMs: options.retryMs ?? [1_000],
    warn: () => {},
  })
  return { wake: createWake({ delivery }), delivery, deliveries, clock, ...l }
}

describe('plugin wake (an adapter over the delivery service)', () => {
  test('an immediate wake (a reminder) is stored with needs.immediate, so the reach ladder never holds it', async () => {
    const t = setup()
    expect(
      await t.wake.deliver('reminders', request('ana', undefined, { immediate: true })),
    ).toEqual({ delivered: true })
    // `needs` is stored as a JSON column
    const needsOf = (raw: unknown) => JSON.parse(String(raw)) as { immediate?: boolean }
    expect(needsOf(t.deliveries.get('fire-1')?.needs).immediate).toBe(true)
    const plain = setup()
    await plain.wake.deliver('notes', request('ana'))
    expect(needsOf(plain.deliveries.get('fire-1')?.needs).immediate).toBeUndefined()
  })

  test('an active recipient is woken in their own front session, keyed by the run id', async () => {
    const t = setup()
    expect(await t.wake.deliver('notes', request('ana'))).toEqual({ delivered: true })
    expect(t.injected.map((i) => i.session)).toEqual(['front:ana'])
    expect(t.injected[0]?.options).toMatchObject({ wake: true, key: 'fire-1' })
  })

  test('a payer other than the recipient rides as billTo in the principal', async () => {
    const t = setup()
    await t.wake.deliver('reminders', request('ana', 'owner'))
    expect(t.injected[0]?.options).toMatchObject({
      principal: { id: 'ana', billTo: 'owner' },
    })
  })

  test('the same run id is woken once, however often the plugin asks', async () => {
    const t = setup()
    const first = await t.wake.deliver('notes', request('ana'))
    const again = await t.wake.deliver('notes', request('ana', undefined, { text: 'other' }))
    expect(again).toEqual(first)
    expect(t.injected).toHaveLength(1)
  })

  test('a suspended or removed recipient gets no turn, whichever plugin asks', async () => {
    const t = setup({ isActive: (id) => id !== 'bob' })
    expect(await t.wake.deliver('any-plugin', request('bob'))).toEqual({
      delivered: false,
      reason: 'recipient-gone',
    })
    expect(t.injected).toEqual([])
  })

  test('the recipient is checked before the payer budget', async () => {
    const t = setup({ isActive: () => false, remainingUsd: () => 0 })
    expect(await t.wake.deliver('notes', request('ana', 'owner'))).toEqual({
      delivered: false,
      reason: 'recipient-gone',
    })
  })

  test('an empty payer budget is a budget refusal for an active recipient', async () => {
    const t = setup({ remainingUsd: () => 0 })
    expect(await t.wake.deliver('notes', request('ana', 'owner'))).toEqual({
      delivered: false,
      reason: 'budget',
    })
    expect(t.injected).toEqual([])
  })

  test('an unreachable front agent queues the wake; the retry delivers it once', async () => {
    const t = setup()
    t.state.down = true
    expect(await t.wake.deliver('reminders', request('ana'))).toEqual({
      delivered: true,
      queued: { nextAttemptAt: 2_000 },
    })
    expect(t.injected).toEqual([])
    t.state.down = false
    t.clock.now = 2_000
    await t.delivery.tick()
    await t.delivery.tick()
    expect(t.injected.map((i) => i.session)).toEqual(['front:ana'])
  })

  test('a wake that every retry could not deliver is a failure, and its notice is stored for the creator', async () => {
    const t = setup({ retryMs: [] })
    t.state.down = true
    const failureNotice = { to: 'owner', text: 'could not be delivered', key: 'fire-1:day' }
    expect(await t.wake.deliver('reminders', request('ana', undefined, { failureNotice }))).toEqual(
      { delivered: false, reason: 'unavailable' },
    )
    const notice = t.deliveries.get('report:fire-1:day')
    expect(notice).toMatchObject({ recipientId: 'owner', needs: expect.any(String) })
  })
})
