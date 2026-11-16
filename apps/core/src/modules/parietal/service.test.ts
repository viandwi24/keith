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
import { DEFAULT_WINDOWS } from './compute.ts'
import { clientContextBlock } from './context-block.ts'
import { createParietalService, ParietalError, type ParietalService } from './service.ts'

// The parietal service (docs/specs/parietal.md, "Contracts", "Signals and computation"): registers, heartbeats, goodbyes,
// the signals, the recomputation and the one event per change of state on the person's front session.

const SEC = 1_000
const MIN = 60 * SEC

interface Harness {
  service: ParietalService
  sqlite: Sqlite
  events: { type: string; sessionId: string | null; payload: Record<string, unknown> }[]
  clock: { now: number }
  people: string[]
}

function harness(
  sqlite: Sqlite = db(),
  clock = { now: 10_000_000 },
  people = ['ana', 'ben'],
): Harness {
  const events: Harness['events'] = []
  const store = {
    append(record: { type: string; sessionId: string | null; payload: Record<string, unknown> }) {
      events.push({ type: record.type, sessionId: record.sessionId, payload: record.payload })
      return Promise.resolve(record)
    },
  } as unknown as ActivityStore
  const service = createParietalService({
    generations: { current: () => 0 },
    repos: {
      clients: clientsRepo(sqlite),
      signals: presenceSignalsRepo(sqlite),
      status: presenceStatusRepo(sqlite),
      disclosure: presenceDisclosureRepo(sqlite),
    },
    people: {
      list: async () => people.map((id) => ({ id }) as never),
      get: async (id: string) => {
        throw new Error(`no person ${id}`)
      },
    },
    acl: { getGroup: () => undefined, listGroups: () => [], members: () => [] },
    store,
    windows: DEFAULT_WINDOWS,
    now: () => clock.now,
  })
  return { service, sqlite, events, clock, people }
}

function db(): Sqlite {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const reg = (n: number, extra: Partial<ClientRegister> = {}): ClientRegister => ({
  id: uuid(n),
  kind: 'tui',
  label: `laptop ${n}`,
  capabilities: ['chat', 'notify'],
  version: '0.1.0',
  ...extra,
})

const refusal = (fn: () => unknown): ParietalError | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof ParietalError ? error : undefined
  }
  return undefined
}

describe('register', () => {
  test('the first register creates the client; a second one updates it', () => {
    const { service, clock } = harness()
    const first = service.register('ana', reg(1))
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({
      id: uuid(1),
      personId: 'ana',
      online: true,
      lastActiveAt: null,
    })
    clock.now += 5 * SEC
    const second = service.register('ana', reg(1, { label: 'laptop renamed' }))
    expect(second.created).toBe(false)
    expect(second.record).toMatchObject({
      label: 'laptop renamed',
      firstSeenAt: first.record.firstSeenAt,
    })
  })

  test("another person's client id is a CONFLICT and nothing changes", () => {
    const { service } = harness()
    service.register('ana', reg(1))
    const error = refusal(() => service.register('ben', reg(1)))
    expect(error?.code).toBe('CONFLICT')
    expect(service.list('ben')).toEqual([])
    expect(service.list('ana').map((c) => c.id)).toEqual([uuid(1)])
  })

  test('the 21st client of a person is a CONFLICT; 20 are allowed', () => {
    const { service, clock } = harness()
    for (let n = 1; n <= 20; n++) {
      service.register('ana', reg(n))
      clock.now += 7 * SEC // stay under the register limit
    }
    expect(service.list('ana')).toHaveLength(20)
    expect(refusal(() => service.register('ana', reg(21)))?.code).toBe('CONFLICT')
  })

  test('at most 10 registers a minute per person, then the window reopens', () => {
    const { service, clock } = harness()
    for (let n = 1; n <= 10; n++) service.register('ana', reg(n))
    expect(refusal(() => service.register('ana', reg(11)))?.code).toBe('TOO_MANY_REQUESTS')
    // another person has their own window
    expect(() => service.register('ben', reg(50))).not.toThrow()
    clock.now += MIN + 1
    expect(() => service.register('ana', reg(11))).not.toThrow()
  })

  test('a register records client.connected and makes the person online', () => {
    const { service, sqlite } = harness()
    service.register('ana', reg(1))
    const rows = sqlite
      .query<{ type: string }, []>('SELECT type FROM presence_signals ORDER BY at')
      .all()
    expect(rows.map((r) => r.type)).toEqual(['client.connected'])
  })
})

describe('heartbeat', () => {
  test('the workspace view of the latest beat is on the online client, never in the raw read, gone after goodbye', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    clock.now += 6 * SEC
    service.heartbeat('ana', { id: uuid(1), active: false, view: { mode: 'ambient' } })
    clock.now += 1 * SEC // too soon for a beat, not for the view
    service.heartbeat('ana', {
      id: uuid(1),
      active: false,
      view: { mode: 'workspace', desktopId: 'd2' },
    })
    expect(service.list('ana')[0]?.view).toEqual({ mode: 'workspace', desktopId: 'd2' })
    expect(service.raw('ana').clients[0]).not.toHaveProperty('view')
    service.goodbye('ana', uuid(1))
    expect(service.list('ana')[0]?.view).toBeUndefined()
  })

  test('a heartbeat sooner than 5 s after the last one is ignored', () => {
    const { service, clock, sqlite } = harness()
    const t0 = clock.now
    service.register('ana', reg(1))
    const seen = () =>
      sqlite.query<{ last_seen_at: number }, []>('SELECT last_seen_at FROM clients').get()
        ?.last_seen_at
    clock.now = t0 + 2 * SEC
    service.heartbeat('ana', { id: uuid(1), active: false })
    expect(seen()).toBe(t0 + 2 * SEC)
    clock.now = t0 + 4 * SEC // 2 s after the last beat: ignored
    service.heartbeat('ana', { id: uuid(1), active: false })
    expect(seen()).toBe(t0 + 2 * SEC)
    clock.now = t0 + 8 * SEC // 6 s after the last beat: accepted
    service.heartbeat('ana', { id: uuid(1), active: false })
    expect(seen()).toBe(t0 + 8 * SEC)
  })

  test('a heartbeat with active records client.active; without it, nothing is written', () => {
    const { service, clock, sqlite } = harness()
    service.register('ana', reg(1))
    clock.now += 6 * SEC
    service.heartbeat('ana', { id: uuid(1), active: false })
    const count = () =>
      sqlite
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM presence_signals WHERE type = 'client.active'",
        )
        .get()?.n
    expect(count()).toBe(0)
    clock.now += 6 * SEC
    service.heartbeat('ana', { id: uuid(1), active: true })
    expect(count()).toBe(1)
    expect(service.presence('ana').state).toBe('active')
  })

  test("another person's client and an unknown one are refused alike (NOT_FOUND)", () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    clock.now += 6 * SEC
    expect(refusal(() => service.heartbeat('ben', { id: uuid(1), active: true }))?.code).toBe(
      'NOT_FOUND',
    )
    expect(refusal(() => service.heartbeat('ana', { id: uuid(9), active: true }))?.code).toBe(
      'NOT_FOUND',
    )
  })
})

describe('a client that times out', () => {
  test('goes offline after the timeout and the change is emitted once', async () => {
    const { service, clock, events, people } = harness()
    service.register('ana', reg(1))
    clock.now += 6 * SEC
    service.heartbeat('ana', { id: uuid(1), active: true })
    expect(service.presence('ana').state).toBe('active')
    expect(people).toHaveLength(2)

    clock.now += 61 * SEC
    await service.recomputeAll()
    expect(service.presence('ana').state).toBe('offline')
    await service.recomputeAll()

    const states = events.filter((e) => e.payload.personId === 'ana').map((e) => e.payload)
    expect(states).toEqual([
      { region: 'parietal', personId: 'ana', state: 'away', previous: null },
      { region: 'parietal', personId: 'ana', state: 'active', previous: 'away' },
      { region: 'parietal', personId: 'ana', state: 'offline', previous: 'active' },
    ])
    expect(events.every((e) => e.type === 'brain.parietal.presence')).toBe(true)
    for (const e of events) expect(e.sessionId).toBe(`front:${e.payload.personId}`)
  })
})

describe('goodbye takes the client offline at once', () => {
  test('after goodbye the client is not online and the person is not, before any timeout', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    expect(service.list('ana')[0]?.online).toBe(true)
    clock.now += 5 * SEC
    service.goodbye('ana', uuid(1))
    expect(service.list('ana')[0]?.online).toBe(false)
    expect(service.presence('ana').reachableOn).toEqual([])
    expect(service.presence('ana').state).toBe('offline')
  })

  test('a heartbeat after the goodbye brings the client back online', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    clock.now += 5 * SEC
    service.goodbye('ana', uuid(1))
    clock.now += 5 * SEC
    service.heartbeat('ana', { id: uuid(1), active: false })
    expect(service.list('ana')[0]?.online).toBe(true)
    expect(service.presence('ana').reachableOn).toEqual([uuid(1)])
  })

  test('a register after the goodbye brings the client back online', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    clock.now += 5 * SEC
    service.goodbye('ana', uuid(1))
    clock.now += 5 * SEC
    service.register('ana', reg(1))
    expect(service.list('ana')[0]?.online).toBe(true)
  })

  test('the reminder block is gone after goodbye and comes back with the next heartbeat', () => {
    const { service, clock } = harness()
    const block = () =>
      clientContextBlock({
        clients: service.list('ana'),
        activeClient: service.presence('ana').activeClient,
        now: clock.now,
      })
    service.register('ana', reg(1))
    expect(block()).toBeDefined()
    clock.now += 5 * SEC
    service.goodbye('ana', uuid(1))
    expect(block()).toBeUndefined()
    clock.now += 5 * SEC
    service.heartbeat('ana', { id: uuid(1), active: false })
    expect(block()).toBeDefined()
  })

  test('a goodbye of one client leaves the other online clients as they are', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    service.register('ana', reg(2))
    clock.now += 5 * SEC
    service.goodbye('ana', uuid(1))
    const online = Object.fromEntries(service.list('ana').map((c) => [c.id, c.online]))
    expect(online).toEqual({ [uuid(1)]: false, [uuid(2)]: true })
  })
})

describe('goodbye, remove and restart', () => {
  test('goodbye records client.disconnected and refuses an unknown id', () => {
    const { service, sqlite } = harness()
    service.register('ana', reg(1))
    service.goodbye('ana', uuid(1))
    const types = sqlite
      .query<{ type: string }, []>('SELECT type FROM presence_signals ORDER BY at')
      .all()
    expect(types.map((t) => t.type)).toEqual(['client.connected', 'client.disconnected'])
    expect(refusal(() => service.goodbye('ben', uuid(1)))?.code).toBe('NOT_FOUND')
  })

  test('remove deletes the client of the caller only', () => {
    const { service } = harness()
    service.register('ana', reg(1))
    expect(refusal(() => service.remove('ben', uuid(1)))?.code).toBe('NOT_FOUND')
    service.remove('ana', uuid(1))
    expect(service.list('ana')).toEqual([])
  })

  test('a restart keeps the clients and the last activity', async () => {
    const sqlite = db()
    const first = harness(sqlite, { now: 10_000_000 })
    first.service.register('ana', reg(1))
    first.service.recordActivity('ana')
    const second = harness(sqlite, { now: 10_000_000 + 30 * SEC })
    expect(second.service.list('ana').map((c) => c.id)).toEqual([uuid(1)])
    expect(second.service.list('ana')[0]?.online).toBe(true)
    expect(second.service.presence('ana').state).toBe('active')
    await second.service.recomputeAll()
    const ana = second.events.filter((e) => e.payload.personId === 'ana').map((e) => e.payload)
    expect(ana).toEqual([{ region: 'parietal', personId: 'ana', state: 'active', previous: null }])
  })
})

describe('activity and the manual status', () => {
  test('a sent message is an activity signal: the person is active until the window passes', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    service.recordActivity('ana')
    expect(service.presence('ana').state).toBe('active')
    clock.now += DEFAULT_WINDOWS.activeWindowMs + 1
    expect(service.presence('ana').state).toBe('offline')
  })

  test('a busy status with minutes overrides the state and expires on its own', () => {
    const { service, clock } = harness()
    service.register('ana', reg(1))
    service.recordActivity('ana')
    const view = service.setStatus('ana', { busy: true, note: '  in a meeting ', minutes: 30 })
    expect(view).toMatchObject({ busy: true, note: 'in a meeting' })
    expect(service.presence('ana')).toMatchObject({ state: 'busy', note: 'in a meeting' })
    clock.now += 31 * MIN
    expect(service.status('ana')).toMatchObject({ busy: false, note: null, until: null })
    expect(service.presence('ana').state).not.toBe('busy')
  })

  test('a busy status without minutes lasts a day at most; /free clears it', () => {
    const { service, clock } = harness()
    const view = service.setStatus('ana', { busy: true })
    expect(view.until).toBe(clock.now + 24 * 60 * MIN)
    expect(service.presence('ana').state).toBe('busy')
    service.setStatus('ana', { busy: false })
    expect(service.presence('ana').state).toBe('offline')
  })

  test('mine returns the presence, the clients, the status and every audience with its effective level', () => {
    const { service, sqlite } = harness()
    service.register('ana', reg(1))
    presenceDisclosureRepo(sqlite).set('ana', '@users', 'state')
    const mine = service.mine('ana')
    expect(mine.clients.map((c) => c.id)).toEqual([uuid(1)])
    expect(mine.status).toMatchObject({ busy: false, note: null, until: null, kind: null })
    // the owner audience and @users always appear; a stored level wins over the default, a group has none
    expect(mine.disclosure).toEqual([
      { audience: 'owner', level: 'detail' },
      { audience: '@users', level: 'state' },
    ])
    expect(mine.presence.personId).toBe('ana')
  })
})
