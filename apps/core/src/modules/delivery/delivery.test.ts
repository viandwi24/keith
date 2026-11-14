import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryNeeds, DeliveryRequest, DeliveryRequestInput } from '@keith/contracts'
import { deliveriesRepo, migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { createRemovalRegistry } from '../people/index.ts'
import {
  createDelivery,
  type DeliveryRoute,
  type RoutePlanner,
  type RouteResult,
} from './delivery.ts'
import { singleRoutePlanner } from './planner.ts'
import { deliveryRemoval } from './removal.ts'

const OK: RouteResult = { ok: true }
const UNAVAILABLE: RouteResult = { ok: false, reason: 'unavailable' }
const BUDGET: RouteResult = { ok: false, reason: 'budget' }

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A route that answers the queued results in order (then `ok`) and records every request it was sent. */
function scripted(id: string, queue: RouteResult[] = []) {
  const calls: DeliveryRequest[] = []
  const route: DeliveryRoute = {
    id,
    async send(request) {
      calls.push(request)
      return queue.shift() ?? OK
    },
  }
  return { route, calls }
}

const request = (overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput => ({
  id: 'reminder:r1:fire-1',
  source: 'plugin:reminders',
  to: 'ana',
  name: 'reminder',
  text: 'pay the rent',
  ...overrides,
})

interface Setup {
  sqlite: Sqlite
  clock: { now: number }
  deliveries: ReturnType<typeof deliveriesRepo>
  audit: { kind: string; detail: Record<string, unknown> | undefined }[]
  activity: { sessionId: string; type: string; payload: Record<string, unknown> }[]
}

/** A fresh database, a fake clock, and a delivery service over the given routes (or planner). */
function setup(
  options: {
    route?: DeliveryRoute
    planner?: RoutePlanner
    isActive?: (id: string) => boolean
    retryMs?: readonly number[]
  } = {},
) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { now: 1_000 }
  const deliveries = deliveriesRepo(sqlite, { now: () => clock.now })
  const audit: Setup['audit'] = []
  const activity: Setup['activity'] = []
  const front = options.route ?? scripted('front').route
  const delivery = createDelivery({
    generations: { current: () => 0 },
    deliveries,
    planner: options.planner ?? singleRoutePlanner(front),
    audit: { record: (event) => void audit.push({ kind: event.kind, detail: event.detail }) },
    activity: {
      record: (sessionId, type, payload) => void activity.push({ sessionId, type, payload }),
    },
    ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    now: () => clock.now,
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    warn: () => {},
  })
  return { delivery, setup: { sqlite, clock, deliveries, audit, activity } }
}

describe('deliver: exactly once by run id', () => {
  test('a run id is sent once; a second deliver with the same id returns the stored outcome and sends nothing', async () => {
    const front = scripted('front')
    const { delivery, setup: s } = setup({ route: front.route })
    const first = await delivery.deliver(request())
    const second = await delivery.deliver(request({ text: 'changed text' }))
    expect(first).toEqual({ status: 'delivered', route: 'front', attempts: 1 })
    expect(second).toEqual(first)
    expect(front.calls).toHaveLength(1)
    expect(front.calls[0]?.text).toBe('pay the rent')
    expect(s.audit.filter((e) => e.kind === 'delivery.sent')).toHaveLength(1)
  })

  test('a delivered row keeps no text', async () => {
    const { delivery, setup: s } = setup()
    await delivery.deliver(request())
    expect(s.deliveries.get('reminder:r1:fire-1')).toMatchObject({ status: 'delivered', text: '' })
  })

  test('a failed run answers the same failure on a repeat and sends nothing again', async () => {
    const front = scripted('front', [BUDGET])
    const { delivery } = setup({ route: front.route })
    const first = await delivery.deliver(request())
    const second = await delivery.deliver(request())
    expect(first).toEqual({ status: 'failed', reason: 'budget', attempts: 1 })
    expect(second).toEqual(first)
    expect(front.calls).toHaveLength(1)
  })

  test('a new service over the same table does not send a run that was already delivered (restart)', async () => {
    const first = scripted('front')
    const a = setup({ route: first.route })
    await a.delivery.deliver(request())
    const second = scripted('front')
    const b = createDelivery({
      generations: { current: () => 0 },
      deliveries: a.setup.deliveries,
      planner: singleRoutePlanner(second.route),
      audit: { record() {} },
      now: () => a.setup.clock.now,
    })
    expect(await b.deliver(request())).toEqual({ status: 'delivered', route: 'front', attempts: 1 })
    expect(second.calls).toHaveLength(0)
  })
})

describe('retries on an unavailable route', () => {
  test('retries at 1, 5 and 30 minutes on the fake clock, then delivers once', async () => {
    const front = scripted('front', [UNAVAILABLE, UNAVAILABLE, OK])
    const { delivery, setup: s } = setup({ route: front.route })
    expect(await delivery.deliver(request())).toEqual({
      status: 'queued',
      reason: 'unavailable',
      nextAttemptAt: 61_000,
    })
    s.clock.now = 60_999
    await delivery.tick()
    expect(front.calls).toHaveLength(1)

    s.clock.now = 61_000
    await delivery.tick()
    expect(front.calls).toHaveLength(2)
    expect(s.deliveries.get('reminder:r1:fire-1')).toMatchObject({
      status: 'pending',
      attempts: 2,
      nextAttemptAt: 361_000,
    })

    s.clock.now = 361_000
    await delivery.tick()
    expect(front.calls).toHaveLength(3)
    expect(s.deliveries.get('reminder:r1:fire-1')).toMatchObject({
      status: 'delivered',
      attempts: 3,
      text: '',
    })
    expect(s.audit.filter((e) => e.kind === 'delivery.retry')).toHaveLength(2)
    expect(s.audit.filter((e) => e.kind === 'delivery.sent')).toEqual([
      {
        kind: 'delivery.sent',
        detail: {
          id: 'reminder:r1:fire-1',
          source: 'plugin:reminders',
          to: 'ana',
          route: 'front',
          attempts: 3,
        },
      },
    ])
  })

  test('after the last retry the delivery fails, the creator is told once, and the recipient gets one record without text', async () => {
    const front = scripted('front', [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE])
    const { delivery, setup: s } = setup({ route: front.route })
    const notice = {
      to: 'owner',
      text: 'The reminder for Ana could not be delivered.',
      key: 'r1:2026-11-10',
    }
    await delivery.deliver(request({ onFailure: notice }))
    s.clock.now = 61_000
    await delivery.tick()
    s.clock.now = 361_000
    await delivery.tick()
    s.clock.now = 2_161_000
    await delivery.tick()

    expect(s.deliveries.get('reminder:r1:fire-1')).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
      attempts: 4,
    })
    // the fourth attempt is the last: the notice is the fifth call, a note to the owner
    const report = front.calls[4]
    expect(report).toMatchObject({
      id: 'report:r1:2026-11-10',
      to: 'owner',
      name: 'delivery-failed',
      text: notice.text,
      needs: { mode: 'note' },
    })
    expect(report?.onFailure).toBeUndefined()
    expect(s.audit.filter((e) => e.kind === 'delivery.reported')).toEqual([
      { kind: 'delivery.reported', detail: { id: 'reminder:r1:fire-1', to: 'owner' } },
    ])
    expect(s.activity).toEqual([
      {
        sessionId: 'front:ana',
        type: 'delivery.failed',
        payload: {
          personId: 'ana',
          deliveryId: 'reminder:r1:fire-1',
          source: 'plugin:reminders',
          reason: 'unavailable',
        },
      },
    ])
  })

  test('a custom retry schedule is used in order', async () => {
    const front = scripted('front', [UNAVAILABLE, OK])
    const { delivery, setup: s } = setup({ route: front.route, retryMs: [10] })
    expect(await delivery.deliver(request())).toMatchObject({
      status: 'queued',
      nextAttemptAt: 1_010,
    })
    s.clock.now = 1_010
    await delivery.tick()
    expect(s.deliveries.get('reminder:r1:fire-1')).toMatchObject({ status: 'delivered' })
  })
})

describe('terminal refusals end the delivery at once', () => {
  test('budget: one attempt, no retry, failed with reason budget', async () => {
    const front = scripted('front', [BUDGET])
    const { delivery, setup: s } = setup({ route: front.route })
    expect(await delivery.deliver(request())).toEqual({
      status: 'failed',
      reason: 'budget',
      attempts: 1,
    })
    s.clock.now = 10_000_000
    await delivery.tick()
    expect(front.calls).toHaveLength(1)
    expect(s.audit.map((e) => e.kind)).toEqual(['delivery.failed'])
    expect(s.activity[0]?.payload).toMatchObject({ reason: 'budget' })
  })

  test('an inactive recipient is recipient-gone and the route is never asked', async () => {
    const front = scripted('front')
    const { delivery } = setup({ route: front.route, isActive: (id) => id !== 'ana' })
    expect(await delivery.deliver(request())).toEqual({
      status: 'failed',
      reason: 'recipient-gone',
      attempts: 1,
    })
    expect(front.calls).toHaveLength(0)
  })

  test('a planner that offers no route is no-route', async () => {
    const { delivery } = setup({ planner: { plan: async () => [] } })
    expect(await delivery.deliver(request())).toEqual({
      status: 'failed',
      reason: 'no-route',
      attempts: 1,
    })
  })
})

describe('the failure notice (once per key)', () => {
  test('two failed runs with the same key store one note for the creator', async () => {
    const front = scripted('front', [BUDGET, OK, BUDGET])
    const { delivery, setup: s } = setup({ route: front.route })
    const notice = { to: 'owner', text: 'A reminder could not be delivered.', key: 'r1:2026-11-10' }
    await delivery.deliver(request({ id: 'reminder:r1:fire-1', onFailure: notice }))
    await delivery.deliver(request({ id: 'reminder:r1:fire-2', onFailure: notice }))
    const reports = front.calls.filter((call) => call.id.startsWith('report:'))
    expect(reports).toHaveLength(1)
    expect(front.calls.map((call) => call.id)).toEqual([
      'reminder:r1:fire-1',
      'report:r1:2026-11-10',
      'reminder:r1:fire-2',
    ])
    expect(s.audit.filter((e) => e.kind === 'delivery.failed')).toHaveLength(2)
  })
})

describe('fan-out and the route order', () => {
  const routes = (...specs: [string, RouteResult[]][]) =>
    specs.map(([id, queue]) => scripted(id, queue))
  const planner = (list: ReturnType<typeof scripted>[]): RoutePlanner => ({
    plan: async () => list.map((s) => s.route),
  })
  const needs = (fanout: DeliveryNeeds['fanout']): DeliveryRequestInput =>
    request({ needs: { fanout } })

  test('fanout all tries every route and is delivered when any took it', async () => {
    const list = routes(['a', [UNAVAILABLE]], ['b', [OK]], ['c', [OK]])
    const { delivery } = setup({ planner: planner(list) })
    expect(await delivery.deliver(needs('all'))).toEqual({
      status: 'delivered',
      route: 'b',
      attempts: 1,
    })
    expect(list.map((s) => s.calls.length)).toEqual([1, 1, 1])
  })

  test('fanout best stops at the first route that takes the message', async () => {
    const list = routes(['a', [OK]], ['b', [OK]])
    const { delivery } = setup({ planner: planner(list) })
    expect(await delivery.deliver(needs('best'))).toEqual({
      status: 'delivered',
      route: 'a',
      attempts: 1,
    })
    expect(list[1]?.calls).toHaveLength(0)
  })

  test('fanout best falls to the next route when one is unavailable', async () => {
    const list = routes(['a', [UNAVAILABLE]], ['b', [OK]])
    const { delivery } = setup({ planner: planner(list) })
    expect(await delivery.deliver(needs('best'))).toEqual({
      status: 'delivered',
      route: 'b',
      attempts: 1,
    })
  })

  test('a terminal refusal of one route ends a best delivery without trying the next', async () => {
    const list = routes(['a', [BUDGET]], ['b', [OK]])
    const { delivery } = setup({ planner: planner(list) })
    expect(await delivery.deliver(needs('best'))).toEqual({
      status: 'failed',
      reason: 'budget',
      attempts: 1,
    })
    expect(list[1]?.calls).toHaveLength(0)
  })
})

describe('tick', () => {
  test('a row left pending by a stopped core is attempted by the first tick', async () => {
    const { delivery, setup: s } = setup()
    s.deliveries.create({
      id: 'left-over',
      source: 'plugin:reminders',
      recipientId: 'ana',
      name: 'reminder',
      needs: '{}',
      text: 'water the plants',
      nextAttemptAt: 500,
    })
    await delivery.tick()
    expect(s.deliveries.get('left-over')).toMatchObject({ status: 'delivered', text: '' })
  })

  test('one tick takes at most twenty rows', async () => {
    const front = scripted('front')
    const { delivery, setup: s } = setup({ route: front.route })
    for (let i = 0; i < 25; i++)
      s.deliveries.create({
        id: `row-${i}`,
        source: 'plugin:reminders',
        recipientId: 'ana',
        name: 'reminder',
        needs: '{}',
        text: 'x',
        nextAttemptAt: 0,
      })
    await delivery.tick()
    expect(front.calls).toHaveLength(20)
  })
})

describe('removal of a person (ADR-0027 §26)', () => {
  test('keep leaves the pending rows, export lists their ids only, purge deletes the pending rows of that person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-delivery-removal-'))
    dirs.push(dir)
    const { setup: s } = setup({ route: scripted('front', [UNAVAILABLE]).route })
    const hooks = deliveryRemoval(s.deliveries)
    const registry = createRemovalRegistry()
    registry.registerRemoval({ module: 'delivery', onPersonRemoved: hooks })
    s.deliveries.create({
      id: 'a-1',
      source: 'plugin:reminders',
      recipientId: 'ana',
      name: 'reminder',
      needs: '{}',
      text: 'secret text',
    })
    s.deliveries.create({
      id: 'a-2',
      source: 'plugin:reminders',
      recipientId: 'ana',
      name: 'reminder',
      needs: '{}',
      text: 'x',
    })
    s.deliveries.create({
      id: 'a-done',
      source: 'plugin:reminders',
      recipientId: 'ana',
      name: 'reminder',
      needs: '{}',
      text: 'x',
    })
    s.deliveries.settle('a-done', { status: 'delivered', attempts: 1 })
    s.deliveries.create({
      id: 'b-1',
      source: 'plugin:reminders',
      recipientId: 'ben',
      name: 'reminder',
      needs: '{}',
      text: 'x',
    })

    expect(await hooks.keep('ana', dir)).toBeUndefined()
    expect(s.deliveries.get('a-1')).toBeDefined()

    await hooks.export('ana', dir)
    const exported = readFileSync(join(dir, 'deliveries.json'), 'utf8')
    expect(JSON.parse(exported)).toEqual({ personId: 'ana', pending: ['a-1', 'a-2'] })
    expect(exported).not.toContain('secret text')

    await hooks.purge('ana', dir)
    expect(s.deliveries.get('a-1')).toBeUndefined()
    expect(s.deliveries.get('a-2')).toBeUndefined()
    expect(s.deliveries.get('a-done')).toBeDefined()
    expect(s.deliveries.get('b-1')).toBeDefined()
  })
})

describe('the planner seam', () => {
  test('a planner is asked with the request needs of the delivery', async () => {
    const seen: DeliveryNeeds[] = []
    const { delivery } = setup({
      planner: {
        plan: async (_person, needs) => {
          seen.push(needs)
          return [scripted('front').route]
        },
      },
    })
    await delivery.deliver(request({ needs: { mode: 'note', capabilities: ['notify'] } }))
    expect(seen).toEqual([
      { mode: 'note', capabilities: ['notify'], fanout: 'best', urgency: 'normal' },
    ])
  })
})
