import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { NodeId } from '../shared/types.ts'
import { createPresence } from './presence.ts'
import {
  connect,
  createFakeEventBus,
  createFakeRepos,
  eventually,
  login,
  personId,
  startTestServer,
  type TestServer,
  testConfig,
} from './test-fakes.ts'

const MINUTE = 60_000
const node = (n: number) => `nod_${String(n).padStart(26, '0')}` as NodeId

function unit(lastSeenAt: number | null, awayAfterMinutes = 30) {
  const clock = createFakeClock(1_000 * MINUTE)
  const repos = createFakeRepos()
  const events = createFakeEventBus(clock)
  const id = personId(1)
  repos.data.persons.set(id, {
    id,
    name: 'Tony',
    username: 'tony',
    passwordHash: null,
    tier: 'owner',
    lastSeenAt,
    createdAt: 0,
  })
  const presence = createPresence({
    config: testConfig({ awayAfterMinutes }),
    clock,
    log: createMemoryLogger(),
    events,
    persons: repos.persons,
  })
  return { clock, repos, events, id, presence }
}

describe('presence', () => {
  test('first-ever attach is an arrival with awayMs null', async () => {
    const { presence, id } = unit(null)
    expect(await presence.arrivalFor(id)).toEqual({ awayMs: null })
  })

  test('arrival only after the away threshold (fractional minutes allowed)', async () => {
    const { presence, id, clock } = unit(1_000 * MINUTE - 10 * MINUTE, 10.5)
    expect(await presence.arrivalFor(id)).toBeNull()
    clock.advance(MINUTE / 2)
    expect(await presence.arrivalFor(id)).toEqual({ awayMs: 10.5 * MINUTE })
  })

  test('no arrival while already present', async () => {
    const { presence, id } = unit(null)
    presence.nodeAttached(id, node(1))
    expect(presence.isPresent(id)).toBe(true)
    expect(await presence.arrivalFor(id)).toBeNull()
  })

  test('becoming away writes last_seen_at and emits person.left', async () => {
    const { presence, id, clock, repos, events } = unit(null)
    presence.nodeAttached(id, node(1))
    presence.nodeAttached(id, node(2))
    clock.advance(5_000)
    await presence.nodeDetached(id, node(1))
    expect(presence.isPresent(id)).toBe(true)
    expect(repos.data.lastSeenWrites).toEqual([])
    await presence.nodeDetached(id, node(2))
    expect(presence.isPresent(id)).toBe(false)
    expect(presence.lastSeenAt(id)).toBe(clock.now())
    expect(repos.data.persons.get(id)?.lastSeenAt).toBe(clock.now())
    expect(events.named('person.left')).toEqual([{ personId: id }])
  })

  test('scheduler ticks refresh last_seen_at for present persons only', async () => {
    const { presence, id, repos, events } = unit(null)
    events.emit('scheduler.ticked', { at: 123 })
    await events.idle()
    expect(repos.data.lastSeenWrites).toEqual([])
    presence.nodeAttached(id, node(1))
    events.emit('scheduler.ticked', { at: 456 })
    await events.idle()
    expect(repos.data.lastSeenWrites).toEqual([{ ids: [id], at: 456 }])
    expect(presence.lastSeenAt(id)).toBe(456)
  })

  test('flushPresence writes everyone present', async () => {
    const { presence, id, repos, clock } = unit(null)
    await presence.flushPresence()
    expect(repos.data.lastSeenWrites).toEqual([])
    presence.nodeAttached(id, node(1))
    await presence.flushPresence()
    expect(repos.data.lastSeenWrites).toEqual([{ ids: [id], at: clock.now() }])
  })
})

describe('arrival over the wire', () => {
  let servers: TestServer[] = []
  afterEach(async () => {
    for (const s of servers) await s.stop()
    servers = []
  })

  async function openMain(s: TestServer) {
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    client.send('thread.open', {})
    await client.next('thread.opened')
    return client
  }

  test('person.arrived fires on first-ever attach, not on a quick reconnect, then after the threshold', async () => {
    const s = await startTestServer({ awayAfterMinutes: 30 })
    servers.push(s)
    const first = await openMain(s)
    await eventually(() => s.events.named('person.arrived').length === 1)
    expect(s.events.named('person.arrived')).toEqual([{ personId: s.owner.id, awayMs: null }])
    expect(s.threads.calls.open[0]?.arrival).toEqual({ awayMs: null })

    await first.close()
    await eventually(() => s.events.named('person.left').length === 1)
    s.clock.advance(5 * MINUTE)
    const second = await openMain(s)
    expect(s.threads.calls.open[1]?.arrival).toBeNull()
    expect(s.events.named('person.arrived')).toHaveLength(1)

    await second.close()
    await eventually(() => s.events.named('person.left').length === 2)
    s.clock.advance(31 * MINUTE)
    await openMain(s)
    expect(s.threads.calls.open[2]?.arrival).toEqual({ awayMs: 31 * MINUTE })
    await eventually(() => s.events.named('person.arrived').length === 2)
  })

  test('a second node of a present person is not an arrival', async () => {
    const s = await startTestServer()
    servers.push(s)
    await openMain(s)
    s.clock.advance(60 * MINUTE)
    await openMain(s)
    expect(s.threads.calls.open.map((c) => c.arrival)).toEqual([{ awayMs: null }, null])
  })

  test('arrival survives a server restart through the persisted last_seen_at', async () => {
    const repos = createFakeRepos()
    const clock = createFakeClock(1_790_000_000_000)
    const a = await startTestServer({ repos, clock })
    servers.push(a)
    await openMain(a)
    // Graceful shutdown: bootstrap flushes presence before stopping.
    clock.advance(MINUTE)
    await a.presence.flushPresence()
    await a.stop()
    servers = []
    expect(repos.data.persons.get(a.owner.id)?.lastSeenAt).toBe(clock.now())

    clock.advance(10 * MINUTE)
    const b = await startTestServer({ repos, clock })
    servers.push(b)
    await openMain(b)
    expect(b.threads.calls.open[0]?.arrival).toBeNull()
    await b.presence.flushPresence()
    await b.stop()
    servers = []

    clock.advance(45 * MINUTE)
    const c = await startTestServer({ repos, clock })
    servers.push(c)
    await openMain(c)
    expect(c.threads.calls.open[0]?.arrival).toEqual({ awayMs: 45 * MINUTE })
  })
})
