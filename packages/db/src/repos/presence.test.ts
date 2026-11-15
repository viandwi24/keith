import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { clientsRepo } from './clients.ts'
import { presenceDisclosureRepo } from './presence-disclosure.ts'
import { presenceSignalsRepo } from './presence-signals.ts'
import { presenceStatusRepo } from './presence-status.ts'

// Repos of the parietal tables (P27.1.2, docs/specs/parietal.md "Data"): clients, signals, manual status, disclosure.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const client = (n: number, extra: { capabilities?: string[] } = {}) => ({
  id: uuid(n),
  kind: 'tui' as const,
  label: `laptop ${n}`,
  capabilities: extra.capabilities ?? ['chat', 'notify'],
  version: '0.1.0',
})

describe('clients', () => {
  test('a first register creates the row; a second one updates it and keeps the first seen time', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    const first = repo.register('ana', client(1), 100)
    expect(first).toMatchObject({ status: 'registered', created: true })
    const again = repo.register('ana', { ...client(1), label: 'desk' }, 200)
    expect(again).toMatchObject({
      status: 'registered',
      created: false,
      record: { label: 'desk', firstSeenAt: 100, lastSeenAt: 200, lastActiveAt: null },
    })
    expect(repo.listFor('ana')).toHaveLength(1)
  })

  test('an id of another person is refused and changes nothing (no hijack)', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    repo.register('ana', client(1), 100)
    expect(repo.register('duta', { ...client(1), label: 'mine now' }, 300)).toEqual({
      status: 'foreign',
    })
    expect(repo.get(uuid(1))).toMatchObject({ personId: 'ana', label: 'laptop 1' })
  })

  test('the 21st client of a person is refused; re-registering one of the 20 still works', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    for (let n = 1; n <= 20; n++)
      expect(repo.register('ana', client(n), n).status).toBe('registered')
    expect(repo.countFor('ana')).toBe(20)
    expect(repo.register('ana', client(21), 50)).toEqual({ status: 'full' })
    expect(repo.register('ana', client(3), 60).status).toBe('registered')
    // another person is not affected by the cap of ana
    expect(repo.register('duta', client(21), 70).status).toBe('registered')
  })

  test('a heartbeat moves last seen; only an active one moves last active; a foreign id changes nothing', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    repo.register('ana', client(1), 100)
    expect(repo.touch('ana', uuid(1), 150, false)).toBe(true)
    expect(repo.get(uuid(1))).toMatchObject({ lastSeenAt: 150, lastActiveAt: null })
    expect(repo.touch('ana', uuid(1), 170, true)).toBe(true)
    expect(repo.get(uuid(1))).toMatchObject({ lastSeenAt: 170, lastActiveAt: 170 })
    expect(repo.touch('duta', uuid(1), 999, true)).toBe(false)
    expect(repo.get(uuid(1))).toMatchObject({ lastSeenAt: 170 })
  })

  test('remove deletes only the person own client', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    repo.register('ana', client(1), 100)
    expect(repo.remove('duta', uuid(1))).toBe(false)
    expect(repo.remove('ana', uuid(1))).toBe(true)
    expect(repo.get(uuid(1))).toBeUndefined()
  })

  test('capabilities round-trip as a list', () => {
    const sqlite = db()
    const repo = clientsRepo(sqlite)
    repo.register('ana', client(1, { capabilities: ['notify', 'open.view'] }), 1)
    expect(repo.get(uuid(1))?.capabilities).toEqual(['notify', 'open.view'])
  })
})

describe('presence signals', () => {
  test('a client.active is stored at most once a minute per client', () => {
    const sqlite = db()
    const signals = presenceSignalsRepo(sqlite)
    const active = (at: number, clientId = uuid(1)) =>
      signals.record({ personId: 'ana', clientId, type: 'client.active', at })
    expect(active(1_000)).toBe(true)
    expect(active(30_000)).toBe(false)
    expect(active(60_999)).toBe(false)
    expect(active(61_000)).toBe(true)
    // another client is not coalesced with the first
    expect(active(61_000, uuid(2))).toBe(true)
    expect(
      sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM presence_signals').get()?.n,
    ).toBe(3)
  })

  test('newest answers the newest time of the listed types only', () => {
    const sqlite = db()
    const signals = presenceSignalsRepo(sqlite)
    signals.record({ personId: 'ana', type: 'activity', at: 10 })
    signals.record({ personId: 'ana', clientId: uuid(1), type: 'client.connected', at: 20 })
    signals.record({ personId: 'ana', type: 'node.event', at: 99 })
    signals.record({ personId: 'duta', type: 'activity', at: 500 })
    expect(signals.newest('ana', ['activity', 'client.active', 'client.connected'])).toBe(20)
    expect(signals.newest('ana', ['node.event'])).toBe(99)
    expect(signals.newest('ana', [])).toBeNull()
    expect(signals.newest('nobody', ['activity'])).toBeNull()
  })

  test('a detail over 200 bytes is refused; a small one is stored', () => {
    const sqlite = db()
    const signals = presenceSignalsRepo(sqlite)
    expect(() =>
      signals.record({
        personId: 'ana',
        type: 'activity',
        at: 1,
        detail: { text: 'x'.repeat(250) },
      }),
    ).toThrow(RangeError)
    expect(signals.record({ personId: 'ana', type: 'activity', at: 1, detail: { n: 1 } })).toBe(
      true,
    )
  })
})

describe('manual status', () => {
  test('set replaces, get reads back, clear removes', () => {
    const sqlite = db()
    const status = presenceStatusRepo(sqlite)
    status.set('ana', { note: 'in a meeting', until: 5_000, setAt: 1_000 })
    status.set('ana', { note: null, until: null, setAt: 2_000 })
    expect(status.get('ana')).toEqual({
      personId: 'ana',
      kind: 'busy',
      note: null,
      from: null,
      until: null,
      setAt: 2_000,
    })
    status.set('ana', {
      kind: 'out',
      note: 'at the clinic',
      from: 3_000,
      until: 9_000,
      setAt: 2_500,
    })
    expect(status.get('ana')).toEqual({
      personId: 'ana',
      kind: 'out',
      note: 'at the clinic',
      from: 3_000,
      until: 9_000,
      setAt: 2_500,
    })
    expect(status.clear('ana')).toBe(true)
    expect(status.clear('ana')).toBe(false)
    expect(status.get('ana')).toBeUndefined()
  })
})

describe('disclosure', () => {
  test('set inserts, then replaces the level of one audience; other audiences stay', () => {
    const sqlite = db()
    const disclosure = presenceDisclosureRepo(sqlite)
    disclosure.set('ana', '@users', 'state')
    disclosure.set('ana', 'owner', 'detail')
    disclosure.set('ana', '@users', 'none')
    expect(disclosure.list('ana')).toEqual([
      { audience: '@users', level: 'none' },
      { audience: 'owner', level: 'detail' },
    ])
    expect(disclosure.list('duta')).toEqual([])
  })
})

describe('signals since', () => {
  test('reads the signals after a cursor in (at, id) order and parses the detail back', () => {
    const sqlite = db()
    const repo = presenceSignalsRepo(sqlite)
    repo.record({ personId: 'ana', type: 'activity', at: 100 })
    repo.record({
      personId: 'ben',
      clientId: 'c2',
      type: 'client.connected',
      at: 200,
      detail: { kind: 'tui' },
    })
    repo.record({ personId: 'ana', type: 'node.event', at: 200, detail: { n: 2 } })
    repo.record({ personId: 'ana', type: 'activity', at: 300 })

    const all = repo.since({ at: 0, id: '' }, 10)
    expect(all.map((row) => row.at)).toEqual([100, 200, 200, 300])
    expect(all[0]?.detail).toBeNull()
    expect(all[1]?.detail).toEqual({ kind: 'tui' })
    expect(all[1]?.clientId).toBe('c2')
    expect(all[2]?.detail).toEqual({ n: 2 })

    // the cursor is exclusive: the row it names and everything before it are not read again
    const second = all[1]
    const next = repo.since({ at: second?.at ?? 0, id: second?.id ?? '' }, 10)
    expect(next.map((row) => row.id)).toEqual([all[2]?.id ?? '', all[3]?.id ?? ''])
  })

  test('a limit caps the page and the next page starts after its last row', () => {
    const sqlite = db()
    const repo = presenceSignalsRepo(sqlite)
    for (let n = 1; n <= 5; n++) repo.record({ personId: 'ana', type: 'activity', at: n * 10 })
    const first = repo.since({ at: 0, id: '' }, 2)
    expect(first.map((row) => row.at)).toEqual([10, 20])
    const last = first[1]
    const second = repo.since({ at: last?.at ?? 0, id: last?.id ?? '' }, 2)
    expect(second.map((row) => row.at)).toEqual([30, 40])
    expect(repo.since({ at: 50, id: 'zzz' }, 2)).toEqual([])
  })
})
