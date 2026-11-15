import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryRequest, DeliveryRequestInput, PresenceState } from '@keith/contracts'
import { deliveriesRepo, migrateDatabase, openDatabase } from '@keith/db'
import { createDelivery, type DeliveryRoute, type RoutePlan, type RouteResult } from './delivery.ts'
import { HELD_MAX_MS } from './digest.ts'
import { createPresenceFeed } from './presence-feed.ts'
import { deliveryRemoval } from './removal.ts'
import { interruptingRoute } from './route-front.ts'

// The hold and the return digest (docs/specs/delivery.md "Hold and digest", ADR-0034 §7): a fake clock, a planner that
// answers a scripted plan, and a front route that records the requests.

const request = (
  id: string,
  overrides: Partial<DeliveryRequestInput> = {},
): DeliveryRequestInput => ({
  id,
  source: 'plugin:reminders',
  to: 'ana',
  name: 'reminder',
  text: `text of ${id}`,
  ...overrides,
})

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { now: 1_000 }
  const deliveries = deliveriesRepo(sqlite, { now: () => clock.now })
  const sent: DeliveryRequest[] = []
  const front: DeliveryRoute = {
    id: 'front',
    async send(r): Promise<RouteResult> {
      sent.push(r)
      return { ok: true }
    },
  }
  const state = {
    plan: { hold: { reason: 'away' } } as RoutePlan,
    presence: 'away' as PresenceState,
  }
  const notices: string[] = []
  const audit: { kind: string; detail: Record<string, unknown> | undefined }[] = []
  const delivery = createDelivery({
    generations: { current: () => 0 },
    deliveries,
    planner: { plan: async () => state.plan },
    audit: { record: (e) => void audit.push({ kind: e.kind, detail: e.detail }) },
    now: () => clock.now,
    warn: () => {},
    front,
    notify: async (_person, text) => void notices.push(text),
    presenceOf: () => ({ state: state.presence }),
  })
  return { delivery, deliveries, clock, sent, front, state, notices, audit, sqlite }
}

describe('hold', () => {
  for (const reason of ['busy', 'away', 'out', 'offline'] as const) {
    test(`a hold plan (${reason}) keeps the row as held: text kept, no retry timer, nothing sent`, async () => {
      const s = setup()
      s.state.plan = { hold: { reason } }
      const outcome = await s.delivery.deliver(request('r1'))
      expect(outcome).toEqual({ status: 'held', reason })
      const row = s.deliveries.get('r1')
      expect(row).toMatchObject({
        status: 'held',
        reason: `held:${reason}`,
        nextAttemptAt: null,
        text: 'text of r1',
      })
      expect(s.sent).toHaveLength(0)
      expect(s.deliveries.due(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(0)
      expect(s.audit.find((e) => e.kind === 'delivery.held')?.detail).toMatchObject({ reason })
      // a repeat of the run id answers held and holds nothing twice
      expect(await s.delivery.deliver(request('r1'))).toEqual({ status: 'held', reason })
    })
  }
})

describe('release on return', () => {
  test('many held items make one digest wake turn; rows become delivered with route digest', async () => {
    const s = setup()
    await s.delivery.deliver(request('r1', { name: 'reminder', text: 'pay the rent' }))
    await s.delivery.deliver(request('r2', { name: 'news', text: 'the morning news' }))
    await s.delivery.deliver(request('r3', { to: 'bob' }))
    s.state.presence = 'active'
    await s.delivery.release('ana')
    expect(s.sent).toHaveLength(1)
    const digest = s.sent[0]
    expect(digest).toMatchObject({ to: 'ana', name: 'digest', needs: { mode: 'wake' } })
    expect(digest?.id.startsWith('digest:')).toBe(true)
    expect(digest?.text).toContain('2 messages were held')
    expect(digest?.text).toContain('their language and address')
    expect(digest?.text).toContain('1. reminder: pay the rent')
    expect(digest?.text).toContain('2. news: the morning news')
    expect(digest?.text).not.toContain('text of r3')
    expect(s.deliveries.get('r1')).toMatchObject({ status: 'delivered', route: 'digest', text: '' })
    expect(s.deliveries.get('r2')).toMatchObject({ status: 'delivered', route: 'digest' })
    expect(s.deliveries.get('r3')?.status).toBe('held')
    expect(s.notices).toEqual(['Keith · 2 held messages'])
  })

  test('a second presence record (a second release) makes no second digest', async () => {
    const s = setup()
    await s.delivery.deliver(request('r1'))
    await s.delivery.release('ana')
    await s.delivery.release('ana')
    expect(s.sent).toHaveLength(1)
    expect(s.notices).toHaveLength(1)
  })

  test('a refused digest turn keeps the rows held', async () => {
    const s = setup()
    await s.delivery.deliver(request('r1'))
    s.front.send = async () => ({ ok: false, reason: 'budget' })
    await s.delivery.release('ana')
    expect(s.deliveries.get('r1')?.status).toBe('held')
  })

  test('the presence feed releases when a record says active or idle, and ignores the others', async () => {
    const s = setup()
    await s.delivery.deliver(request('r1'))
    const records: { seq: number; payload: unknown }[] = []
    const feed = createPresenceFeed({
      feed: {
        lastSeq: async () => 0,
        read: async (q) => records.filter((r) => r.seq > q.after),
      },
      onBack: (person) => s.delivery.release(person),
      everyMs: 1000,
      warn: () => {},
    })
    await feed.poll() // sets the cursor
    records.push({
      seq: 1,
      payload: { region: 'parietal', personId: 'ana', state: 'offline', previous: 'away' },
    })
    await feed.poll()
    expect(s.sent).toHaveLength(0)
    records.push({
      seq: 2,
      payload: { region: 'parietal', personId: 'ana', state: 'active', previous: 'offline' },
    })
    records.push({
      seq: 3,
      payload: { region: 'parietal', personId: 'ana', state: 'idle', previous: 'active' },
    })
    await feed.poll()
    await feed.poll()
    expect(s.sent).toHaveLength(1)
    expect(s.deliveries.get('r1')?.route).toBe('digest')
  })
})

describe('tick', () => {
  test('releases when the person is active or idle again (a missed presence record, a status that ended)', async () => {
    const s = setup()
    await s.delivery.deliver(request('r1'))
    await s.delivery.tick()
    expect(s.sent).toHaveLength(0) // still away
    s.state.presence = 'busy'
    await s.delivery.tick()
    expect(s.sent).toHaveLength(0)
    s.state.presence = 'idle'
    await s.delivery.tick()
    expect(s.sent).toHaveLength(1)
    expect(s.deliveries.get('r1')?.route).toBe('digest')
  })

  test('a row held for more than 7 days is released into the front session as a plain note', async () => {
    const s = setup()
    await s.delivery.deliver(request('old'))
    s.clock.now += HELD_MAX_MS + 1
    await s.delivery.tick()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toMatchObject({ id: 'old', text: 'text of old', needs: { mode: 'note' } })
    expect(s.deliveries.get('old')).toMatchObject({ status: 'delivered', route: 'front' })
    expect(s.notices).toHaveLength(0)
  })
})

describe('urgent while busy', () => {
  test('the front route text asks the agent to open with why it interrupts', async () => {
    const s = setup()
    const wrapped = interruptingRoute(s.front, 'busy')
    await wrapped.send(
      {
        ...(request('u1') as DeliveryRequest),
        needs: { mode: 'wake', capabilities: [], fanout: 'best', urgency: 'high' },
      },
      { attempt: 1 },
    )
    expect(wrapped.id).toBe('front')
    expect(s.sent[0]?.text).toContain('text of u1')
    expect(s.sent[0]?.text).toContain('the person is busy')
    expect(s.sent[0]?.text).toContain('one sentence saying why this interrupts')
  })
})

describe('removal', () => {
  test('export lists held ids and purge deletes the held rows of that person only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-delivery-held-'))
    try {
      const s = setup()
      await s.delivery.deliver(request('h1'))
      await s.delivery.deliver(request('h2', { to: 'bob' }))
      const hooks = deliveryRemoval(s.deliveries)
      hooks.export('ana', dir)
      expect(await Bun.file(join(dir, 'deliveries.json')).json()).toMatchObject({ pending: ['h1'] })
      hooks.purge('ana', dir)
      expect(s.deliveries.get('h1')).toBeUndefined()
      expect(s.deliveries.get('h2')?.status).toBe('held')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
