import { describe, expect, test } from 'bun:test'
import type { ClientRecord, DeliveryNeeds, DeliveryRequestInput, Presence } from '@keith/contracts'
import { deliveriesRepo, migrateDatabase, openDatabase } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import { createDelivery, type DeliveryRoute, type RouteResult } from '../delivery/index.ts'
import { createClientRoute } from './client-route.ts'
import { createPresencePlanner } from './planner.ts'

// The presence planner (docs/specs/delivery.md "Planner seam", docs/specs/parietal.md "Routing"): active client first, then the
// reachable clients by last activity, each only with every capability asked; the front session last. Driven through the real
// delivery service on a fake clock; the ack timeout is a fake timer.

const ANA_LAPTOP = '00000000-0000-4000-8000-00000000000a'
const ANA_PHONE = '00000000-0000-4000-8000-00000000000b'
const ANA_OLD = '00000000-0000-4000-8000-00000000000c'

function client(id: string, overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id,
    personId: 'ana',
    kind: 'tui',
    label: id.slice(-2),
    capabilities: ['chat', 'notify'],
    version: '0.1.0',
    firstSeenAt: 1,
    lastSeenAt: 1_000,
    lastActiveAt: 1_000,
    online: true,
    ...overrides,
  }
}

interface Fixture {
  clients: ClientRecord[]
  activeClient: string | null
  feed: { sessionId: string | null; payload: Record<string, unknown> }[]
  timers: { run: () => void }[]
  ack(clientId: string, deliveryId: string, ok?: boolean): void
  fireTimers(): void
  deliver(overrides?: Partial<DeliveryRequestInput>): Promise<unknown>
  frontCalls: string[]
  routeCalls: string[]
}

/** A delivery service with a presence planner over the given clients; the front route always answers ok. */
function fixture(
  clients: ClientRecord[],
  activeClient: string | null,
  needs?: DeliveryNeeds,
): Fixture {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const feed: Fixture['feed'] = []
  const store = {
    append(record: { sessionId: string | null; payload: Record<string, unknown> }) {
      feed.push({ sessionId: record.sessionId, payload: record.payload })
      return Promise.resolve(record)
    },
  } as unknown as ActivityStore
  const timers: Fixture['timers'] = []
  const route = createClientRoute({
    generations: { current: () => 0 },
    list: (personId) => clients.filter((c) => c.personId === personId),
    store,
    // a timer is live while it waits: an ack or a fire takes it out of the queue
    schedule: (run) => {
      const timer = { run }
      timers.push(timer)
      return () => {
        const at = timers.indexOf(timer)
        if (at >= 0) timers.splice(at, 1)
      }
    },
  })
  const frontCalls: string[] = []
  const routeCalls: string[] = []
  const front: DeliveryRoute = {
    id: 'front',
    async send(request): Promise<RouteResult> {
      frontCalls.push(request.id)
      return { ok: true }
    },
  }
  const parietal = {
    list: (personId: string) => clients.filter((c) => c.personId === personId),
    presence: () => ({ activeClient }) as unknown as Presence,
    callClient: route.callClient,
    ack: route.ack,
  }
  const planner = createPresencePlanner({ parietal, front })
  const wrapped = {
    plan: async (person: string, n: DeliveryNeeds) => {
      const routes = await planner.plan(person, n)
      return routes.map((r) => ({
        ...r,
        send: async (request: Parameters<DeliveryRoute['send']>[0], ctx: { attempt: number }) => {
          routeCalls.push(r.id)
          return r.send(request, ctx)
        },
      }))
    },
  }
  const delivery = createDelivery({
    generations: { current: () => 0 },
    deliveries: deliveriesRepo(sqlite, { now: () => 1_000 }),
    planner: wrapped,
    audit: { record: () => {} },
    activity: { record: () => {} },
    now: () => 1_000,
    retryMs: [],
  })
  const needsCaps: DeliveryNeeds = needs ?? {
    mode: 'wake',
    capabilities: ['notify'],
    fanout: 'best',
    urgency: 'normal',
  }
  return {
    clients,
    activeClient,
    feed,
    timers,
    ack(clientId, deliveryId, ok = true) {
      route.ack('ana', { id: clientId, deliveryId, ok, result: ok ? 'done' : undefined })
    },
    fireTimers() {
      for (const timer of timers.splice(0)) timer.run()
    },
    deliver(overrides = {}) {
      return delivery.deliver({
        id: 'reminder:r1:fire-1',
        source: 'plugin:reminders',
        to: 'ana',
        name: 'reminder',
        text: 'pay the rent',
        needs: needsCaps,
        ...overrides,
      })
    },
    frontCalls,
    routeCalls,
  }
}

/** Waits until the call has scheduled its ack timer (the delivery reaches the client route). */
async function untilAsked(f: Fixture): Promise<void> {
  for (let i = 0; i < 200 && f.timers.length === 0; i++) await Promise.resolve()
}

/** Lets every client that is asked time out (the fake clock passes the ack window) until the delivery settles. */
async function silence(f: Fixture, pending: Promise<unknown>): Promise<unknown> {
  let settled = false
  void pending.then(() => {
    settled = true
  })
  for (let round = 0; round < 20 && !settled; round++) {
    await untilAsked(f)
    f.fireTimers()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return pending
}

describe('createPresencePlanner', () => {
  test('a delivery to the active client is acked and is delivered on that client route', async () => {
    const f = fixture([client(ANA_LAPTOP)], ANA_LAPTOP)
    const pending = f.deliver()
    await untilAsked(f)
    expect(f.feed[0]?.payload).toMatchObject({ clientId: ANA_LAPTOP, capability: 'notify' })
    f.ack(ANA_LAPTOP, 'reminder:r1:fire-1')
    expect(await pending).toEqual({
      status: 'delivered',
      route: `client:${ANA_LAPTOP}`,
      attempts: 1,
    })
    expect(f.frontCalls).toHaveLength(0)
  })

  test('no ack: the client times out and the front session takes the message', async () => {
    const f = fixture([client(ANA_LAPTOP)], ANA_LAPTOP)
    const pending = f.deliver()
    expect(await silence(f, pending)).toEqual({ status: 'delivered', route: 'front', attempts: 1 })
    expect(f.frontCalls).toEqual(['reminder:r1:fire-1'])
  })

  test('a client without the capability is skipped, the next capable client is asked', async () => {
    const quiet = client(ANA_LAPTOP, { capabilities: ['chat'] })
    const f = fixture([quiet, client(ANA_PHONE)], ANA_LAPTOP)
    const pending = f.deliver()
    await untilAsked(f)
    expect(f.feed.map((r) => r.payload.clientId)).toEqual([ANA_PHONE])
    f.ack(ANA_PHONE, 'reminder:r1:fire-1')
    expect(await pending).toEqual({
      status: 'delivered',
      route: `client:${ANA_PHONE}`,
      attempts: 1,
    })
  })

  test('an offline client is skipped; no capable client means the front session only', async () => {
    const f = fixture([client(ANA_LAPTOP, { online: false })], ANA_LAPTOP)
    expect(await f.deliver()).toEqual({ status: 'delivered', route: 'front', attempts: 1 })
    expect(f.feed).toHaveLength(0)
  })

  test('the active client is asked first, then the reachable ones by last activity', async () => {
    const f = fixture(
      [
        client(ANA_OLD, { lastActiveAt: 100 }),
        client(ANA_PHONE, { lastActiveAt: 900 }),
        client(ANA_LAPTOP, { lastActiveAt: 500 }),
      ],
      ANA_LAPTOP,
    )
    const pending = f.deliver()
    await silence(f, pending)
    // the active client first, then by last activity (phone 900, laptop 500 is active, old 100); the front session last
    expect(f.feed.map((r) => r.payload.clientId)).toEqual([ANA_LAPTOP, ANA_PHONE, ANA_OLD])
    expect(f.routeCalls).toEqual([
      `client:${ANA_LAPTOP}`,
      `client:${ANA_PHONE}`,
      `client:${ANA_OLD}`,
      'front',
    ])
  })

  test('with no capability needed the plan is the front session only', async () => {
    const f = fixture([client(ANA_LAPTOP)], ANA_LAPTOP)
    const planner = createPresencePlanner({
      parietal: {
        list: () => [client(ANA_LAPTOP)],
        presence: () => ({ activeClient: ANA_LAPTOP }) as unknown as Presence,
        callClient: async () => ({ ok: false, reason: 'unavailable' }),
      },
      front: { id: 'front', send: async () => ({ ok: true }) },
    })
    const routes = await planner.plan('ana', {
      mode: 'wake',
      capabilities: [],
      fanout: 'best',
      urgency: 'normal',
    })
    expect(routes.map((r) => r.id)).toEqual(['front'])
    expect(f.frontCalls).toHaveLength(0)
  })

  test('fanout all reaches every capable client; the front session is still last', async () => {
    const f = fixture([client(ANA_LAPTOP), client(ANA_PHONE)], ANA_LAPTOP, {
      mode: 'wake',
      capabilities: ['notify'],
      fanout: 'all',
      urgency: 'normal',
    })
    const pending = f.deliver()
    await untilAsked(f)
    f.ack(ANA_LAPTOP, 'reminder:r1:fire-1')
    // the routes are asked one after another: the phone is asked once the laptop route is settled
    await untilAsked(f)
    f.ack(ANA_PHONE, 'reminder:r1:fire-1')
    expect(await pending).toEqual({
      status: 'delivered',
      route: `client:${ANA_LAPTOP}`,
      attempts: 1,
    })
    expect(f.feed.map((r) => r.payload.clientId)).toEqual([ANA_LAPTOP, ANA_PHONE])
  })
})
