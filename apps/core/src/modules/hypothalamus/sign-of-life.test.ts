import { describe, expect, test } from 'bun:test'
import type { ClientRegister } from '@keith/contracts'
import {
  clientsRepo,
  migrateDatabase,
  openDatabase,
  presenceDisclosureRepo,
  presenceSignalsRepo,
  presenceStatusRepo,
  type Sqlite,
} from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import {
  createOverlayRegistry,
  createParietalPorts,
  createParietalService,
  DEFAULT_WINDOWS,
  LAST_SIGN_TYPES,
  type ParietalService,
} from '../parietal/index.ts'
import { createSignOfLife, SIGN_OF_LIFE_SIGNALS, type SignOfLife } from './sign-of-life.ts'

// The sign of life (docs/specs/succession.md, "Sign of life"): what counts, read from the real presence signals of P27,
// and what does not. The signals are written through the real parietal service and repos, so a change in what P27 counts
// shows here. The pause rule is tested on its own with a fake pause port.

const OWNER = 'vian'
const HEIR = 'ana'
const DELEGATE = 'bo'
const T0 = 10_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

interface Fixture {
  sqlite: Sqlite
  service: ParietalService
  signals: ReturnType<typeof presenceSignalsRepo>
  /** The sign of life with no pause (the parietal port alone, plus the pause rule with a null pause). */
  signOfLife: SignOfLife
  clock: { now: number }
}

function fixture(
  pausedUntil: (personId: string) => Promise<number | null> = async () => null,
): Fixture {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const clock = { now: T0 }
  const store = { append: async (record: unknown) => record } as unknown as ActivityStore
  const signals = presenceSignalsRepo(sqlite)
  const service = createParietalService({
    generations: { current: () => 0 },
    repos: {
      clients: clientsRepo(sqlite),
      signals,
      status: presenceStatusRepo(sqlite),
      disclosure: presenceDisclosureRepo(sqlite),
    },
    people: {
      list: async () => [OWNER, HEIR, DELEGATE].map((id) => ({ id }) as never),
      get: async (id: string) => {
        throw new Error(`no person ${id}`)
      },
    },
    acl: { getGroup: () => undefined, listGroups: () => [], members: () => [] },
    store,
    windows: DEFAULT_WINDOWS,
    now: () => clock.now,
  })
  const ports = createParietalPorts({
    signals,
    overlays: createOverlayRegistry(),
    disclosure: { disclosedFor: async () => ({ level: 'none', line: null }) },
  })
  const signOfLife = createSignOfLife({ lastSign: ports.lastSign, pausedUntil })
  return { sqlite, service, signals, signOfLife, clock }
}

const client = (n: number, extra: Partial<ClientRegister> = {}): ClientRegister => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'tui',
  label: `laptop ${n}`,
  capabilities: ['chat', 'notify'],
  version: '0.1.0',
  ...extra,
})

describe('what counts as a sign', () => {
  test('the list is the list parietal counts for lastSign', () => {
    const counted: string[] = [...SIGN_OF_LIFE_SIGNALS].sort()
    const parietal: string[] = [...LAST_SIGN_TYPES].sort()
    expect(counted).toEqual(parietal)
    expect(counted).toEqual(['activity', 'client.active', 'client.connected'])
  })

  test('an owner message (activity) counts', async () => {
    const f = fixture()
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
  })

  test('a client that was in use (client.active) counts, and so does a connect', async () => {
    const f = fixture()
    f.service.register(OWNER, client(1))
    f.clock.now = T0 + HOUR
    f.service.heartbeat(OWNER, { id: client(1).id, active: true })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0 + HOUR)
  })

  test('a reconnect after a sign-in (client.connected) counts', async () => {
    const f = fixture()
    f.clock.now = T0 + 2 * HOUR
    f.service.register(OWNER, client(2))
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0 + 2 * HOUR)
  })
})

describe('what does not count', () => {
  test('a node event does not count, even when it is the newest signal of the owner', async () => {
    const f = fixture()
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    f.signals.record({ personId: OWNER, type: 'node.event', at: T0 + DAY })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
  })

  test('a heartbeat without active does not count', async () => {
    const f = fixture()
    f.service.register(OWNER, client(3))
    const before = await f.signOfLife.lastSign(OWNER)
    f.clock.now = T0 + DAY
    f.service.heartbeat(OWNER, { id: client(3).id, active: false })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(before)
  })

  test('a disconnect does not count', async () => {
    const f = fixture()
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    f.signals.record({ personId: OWNER, type: 'client.disconnected', at: T0 + DAY })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
  })

  test('reads of presence (the polls of a client, the console) write no signal', async () => {
    const f = fixture()
    f.service.register(OWNER, client(4))
    const before = await f.signOfLife.lastSign(OWNER)
    f.clock.now = T0 + DAY
    for (let i = 0; i < 5; i++) {
      f.service.presence(OWNER)
      f.service.mine(OWNER)
      f.service.list(OWNER)
    }
    expect(await f.signOfLife.lastSign(OWNER)).toBe(before)
  })

  test('a signal of the heir does not count for the owner', async () => {
    const f = fixture()
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    f.signals.record({ personId: HEIR, type: 'activity', at: T0 + DAY })
    f.service.register(HEIR, client(5))
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
    expect(await f.signOfLife.lastSign(HEIR)).toBeGreaterThan(T0)
  })

  test('an action by a delegate on the owner account is not a sign: the actor is the delegate', async () => {
    const f = fixture()
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    f.signals.record({ personId: DELEGATE, type: 'activity', at: T0 + DAY })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
  })

  test('no signal at all gives null', async () => {
    expect(await fixture().signOfLife.lastSign(OWNER)).toBeNull()
  })
})

describe('the pause rule', () => {
  test('a pause counts as a sign until it ends: the silence is counted from its end', async () => {
    const until = T0 + 10 * DAY
    const f = fixture(async (personId) => (personId === OWNER ? until : null))
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 - DAY })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(until)
  })

  test('a pause with no earlier sign is the sign', async () => {
    const until = T0 + 3 * DAY
    const f = fixture(async () => until)
    expect(await f.signOfLife.lastSign(OWNER)).toBe(until)
  })

  test('a pause that ended long ago does not lower a newer sign', async () => {
    const f = fixture(async () => T0 - 5 * DAY)
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0)
  })

  test('the pause port is read at each use: a cleared pause gives the parietal sign again', async () => {
    let paused: number | null = T0 + 10 * DAY
    const f = fixture(async () => paused)
    f.signals.record({ personId: OWNER, type: 'activity', at: T0 - DAY })
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0 + 10 * DAY)
    paused = null
    expect(await f.signOfLife.lastSign(OWNER)).toBe(T0 - DAY)
  })
})
