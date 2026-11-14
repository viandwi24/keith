import { describe, expect, test } from 'bun:test'
import { type ComputeClient, computePresence, DEFAULT_WINDOWS } from './compute.ts'
import { createOverlayRegistry, type PresenceOverlay } from './overlay.ts'

const NOW = 10_000_000
const SEC = 1_000
const MIN = 60 * SEC
const P = 'ana'

/** A client seen `seenAgo` ms before now, active `activeAgo` ms before now (null: never active). */
const client = (id: string, seenAgo: number, activeAgo: number | null): ComputeClient => ({
  id,
  lastSeenAt: NOW - seenAgo,
  lastActiveAt: activeAgo === null ? null : NOW - activeAgo,
})

interface Case {
  name: string
  clients?: ComputeClient[]
  activityAgo?: number | null
  overlay?: { note: string | null; until: number }
  state: string
  reachableOn?: string[]
  activeClient?: string | null
}

const cases: Case[] = [
  { name: 'nobody and no activity is offline', state: 'offline' },
  {
    name: 'a client active 10 s ago is active and is the active client',
    clients: [client('tui', 5 * SEC, 10 * SEC)],
    state: 'active',
    reachableOn: ['tui'],
    activeClient: 'tui',
  },
  {
    name: 'an online client never active is away (no active client)',
    clients: [client('tui', 5 * SEC, null)],
    state: 'away',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'an online client active 3 minutes ago is idle',
    clients: [client('tui', 5 * SEC, 3 * MIN)],
    state: 'idle',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'an online client active 31 minutes ago is away',
    clients: [client('tui', 5 * SEC, 31 * MIN)],
    state: 'away',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'a client silent for 61 s is offline',
    clients: [client('tui', 61 * SEC, 61 * SEC)],
    state: 'offline',
    reachableOn: [],
    activeClient: null,
  },
  {
    name: 'activity without any client is active, with no client to reach',
    activityAgo: 10 * SEC,
    state: 'active',
    reachableOn: [],
    activeClient: null,
  },
  {
    name: 'activity older than the active window with no client is offline',
    activityAgo: 3 * MIN,
    state: 'offline',
  },
  {
    name: 'an online client with a recent message from a script is active, no client is named',
    clients: [client('tui', 5 * SEC, 3 * MIN)],
    activityAgo: 20 * SEC,
    state: 'active',
    reachableOn: ['tui'],
    activeClient: 'tui',
  },
  {
    name: 'a manual busy status beats active',
    clients: [client('tui', 5 * SEC, 10 * SEC)],
    overlay: { note: 'in a meeting', until: NOW + 30 * MIN },
    state: 'busy',
    reachableOn: ['tui'],
    activeClient: 'tui',
  },
  {
    name: 'a manual busy status beats offline (no client)',
    overlay: { note: null, until: NOW + 30 * MIN },
    state: 'busy',
    reachableOn: [],
    activeClient: null,
  },
  {
    name: 'busy with no recent activity names no active client',
    clients: [client('tui', 5 * SEC, 10 * MIN)],
    overlay: { note: 'lunch', until: NOW + MIN },
    state: 'busy',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'two clients: the most recently active is reachable first and is the active client',
    clients: [client('web', 5 * SEC, 4 * MIN), client('tui', 5 * SEC, 20 * SEC)],
    state: 'active',
    reachableOn: ['tui', 'web'],
    activeClient: 'tui',
  },
  {
    name: 'two clients: a client never active comes after the active ones',
    clients: [client('a-new', 5 * SEC, null), client('tui', 5 * SEC, 3 * MIN)],
    state: 'idle',
    reachableOn: ['tui', 'a-new'],
    activeClient: null,
  },
  {
    name: 'a timed-out client is not reachable, a live one is',
    clients: [client('old', 90 * SEC, 30 * SEC), client('tui', 5 * SEC, 3 * MIN)],
    state: 'idle',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'a heartbeat exactly at the timeout still counts as online',
    clients: [client('tui', DEFAULT_WINDOWS.clientTimeoutMs, null)],
    state: 'away',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'activity exactly at the active window edge is active',
    clients: [client('tui', 5 * SEC, null)],
    activityAgo: DEFAULT_WINDOWS.activeWindowMs,
    state: 'active',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'activity exactly at the away edge is idle, one ms older is away',
    clients: [client('tui', 5 * SEC, null)],
    activityAgo: DEFAULT_WINDOWS.awayAfterMs,
    state: 'idle',
    reachableOn: ['tui'],
    activeClient: null,
  },
  {
    name: 'one ms older than the away edge is away',
    clients: [client('tui', 5 * SEC, null)],
    activityAgo: DEFAULT_WINDOWS.awayAfterMs + 1,
    state: 'away',
    reachableOn: ['tui'],
    activeClient: null,
  },
]

describe('computePresence', () => {
  for (const c of cases) {
    test(c.name, () => {
      const presence = computePresence({
        personId: P,
        now: NOW,
        clients: c.clients ?? [],
        activityAt:
          c.activityAgo === undefined || c.activityAgo === null ? null : NOW - c.activityAgo,
        overlay: c.overlay,
      })
      expect(presence.state).toBe(c.state as typeof presence.state)
      expect(presence.personId).toBe(P)
      expect(presence.asOf).toBe(NOW)
      if (c.reachableOn !== undefined) expect(presence.reachableOn).toEqual(c.reachableOn)
      if (c.activeClient !== undefined) expect(presence.activeClient).toBe(c.activeClient)
      expect(presence.note).toBe(c.overlay?.note ?? null)
    })
  }

  test('the note of a busy status is carried; without one it is null', () => {
    const busy = computePresence({
      personId: P,
      now: NOW,
      clients: [],
      activityAt: null,
      overlay: { note: 'in a meeting', until: NOW + MIN },
    })
    expect(busy).toMatchObject({ state: 'busy', note: 'in a meeting' })
  })

  test('the windows can be shortened (tests and the core timing)', () => {
    const presence = computePresence({
      personId: P,
      now: NOW,
      clients: [client('tui', 5 * SEC, 5 * SEC)],
      activityAt: null,
      windows: { clientTimeoutMs: 60_000, activeWindowMs: 1_000, awayAfterMs: 2_000 },
    })
    expect(presence.state).toBe('away')
  })
})

describe('overlay sources (docs/specs/parietal.md, "Ports")', () => {
  const overlay = (id: string, busy: PresenceOverlay['busy']): PresenceOverlay => ({ id, busy })

  test('the first source that holds wins, in registration order', () => {
    const reg = createOverlayRegistry()
    reg.add(overlay('manual', () => undefined))
    reg.add(overlay('agenda', () => ({ note: 'standup', until: NOW + MIN })))
    reg.add(overlay('later', () => ({ note: 'later', until: NOW + MIN })))
    expect(reg.busyOf(P, NOW)).toEqual({ note: 'standup', until: NOW + MIN })
  })

  test('a source that expired answers undefined, so presence is not busy', () => {
    const reg = createOverlayRegistry()
    reg.add(overlay('manual', (_p, now) => (now < NOW ? { note: 'x', until: NOW } : undefined)))
    expect(reg.busyOf(P, NOW)).toBeUndefined()
    const presence = computePresence({
      personId: P,
      now: NOW,
      clients: [],
      activityAt: null,
      overlay: reg.busyOf(P, NOW),
    })
    expect(presence.state).toBe('offline')
  })

  test('a source id is registered once', () => {
    const reg = createOverlayRegistry()
    reg.add(overlay('manual', () => undefined))
    expect(() => reg.add(overlay('manual', () => undefined))).toThrow('registered twice')
  })
})
