import { describe, expect, test } from 'bun:test'
import type { Trigger } from '@keith/contracts'
import { memoryScheduleStore } from 'eharness/scheduler'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import {
  type ActiveProtocol,
  createTriggers,
  type FeedRecord,
  type RunStartInput,
  type RunStartOutcome,
  type SignalRow,
  settingsCursorStore,
  TRIGGER_CURSOR_KEY,
} from './triggers.ts'

// A fake clock and in-memory ports: the trigger module reads only what these fakes answer.
const at = (h: number, m = 0, s = 0): number => new Date(2026, 10, 10, h, m, s).getTime()
const T0 = at(8)
const MIN = 60_000
const HOUR = 60 * MIN

const proto = (
  id: string,
  trigger: Trigger,
  over: Partial<ActiveProtocol> = {},
): ActiveProtocol => ({
  id,
  version: 1,
  owner: 'keith',
  savedAt: T0 - HOUR,
  trigger,
  ...over,
})

/** The engine's start port as a fake: a repeated (protocol, ref) answers `duplicate`, as the unique guard does. */
function fakeRuns(): {
  attempts: RunStartInput[]
  started: RunStartInput[]
  failNext: number
  start(input: RunStartInput): Promise<RunStartOutcome>
} {
  const seen = new Set<string>()
  const runs = {
    attempts: [] as RunStartInput[],
    started: [] as RunStartInput[],
    failNext: 0,
    async start(input: RunStartInput): Promise<RunStartOutcome> {
      runs.attempts.push(input)
      if (runs.failNext > 0) {
        runs.failNext--
        throw new Error('engine down')
      }
      const key = `${input.protocolId}|${input.ref}`
      if (seen.has(key)) return 'duplicate'
      seen.add(key)
      runs.started.push(input)
      return 'started'
    },
  }
  return runs
}

function world(startAt: number = T0) {
  const state = { now: startAt }
  const feedRows: FeedRecord[] = []
  let seq = 0
  let pruned = 0
  const signalRows: SignalRow[] = []
  const lastSigns = new Map<string, number>()
  let protocols: ActiveProtocol[] = []
  const settings = new Map<string, unknown>()
  const cursor = settingsCursorStore({
    get: <T>(key: string) => settings.get(key) as T | undefined,
    set: (key, value) => void settings.set(key, value),
  })
  const schedules = memoryScheduleStore()
  const runs = fakeRuns()
  const warnings: string[] = []

  const build = (
    startRuns: { start(input: RunStartInput): Promise<RunStartOutcome> } = runs,
    pingBeforeMs: () => number = () => APPROVAL_PING_BEFORE_MS,
  ) =>
    createTriggers({
      pingBeforeMs,
      runs: startRuns,
      protocols: {
        async active() {
          return protocols
        },
      },
      feed: {
        async read({ after, types, limit }) {
          return feedRows.filter((r) => r.seq > after && types.includes(r.type)).slice(0, limit)
        },
        async lastSeq() {
          return feedRows.reduce((max, r) => Math.max(max, r.seq), 0)
        },
        async prunedThrough() {
          return pruned
        },
      },
      signals: {
        async since(after, limit) {
          return signalRows
            .filter((r) => r.at > after.at || (r.at === after.at && r.id > after.id))
            .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, limit)
        },
      },
      lastSign: {
        async lastSign(person) {
          return lastSigns.get(person) ?? null
        },
      },
      schedules,
      cursor,
      now: () => state.now,
      log: { warn: (message) => void warnings.push(message) },
    })

  return {
    state,
    runs,
    schedules,
    settings,
    warnings,
    build,
    setProtocols(next: ActiveProtocol[]) {
      protocols = next
    },
    addFeed(type: string, payload: Record<string, unknown>, createdAt = state.now): FeedRecord {
      seq++
      const row = { seq, type, payload, createdAt }
      feedRows.push(row)
      return row
    },
    setPruned(value: number) {
      pruned = value
    },
    addSignal(
      row: Omit<SignalRow, 'detail' | 'clientId'> & Partial<Pick<SignalRow, 'detail' | 'clientId'>>,
    ) {
      signalRows.push({ clientId: null, detail: null, ...row })
    },
    setLastSign(person: string, when: number | null) {
      if (when === null) lastSigns.delete(person)
      else lastSigns.set(person, when)
    },
  }
}

const startsOf = (runs: ReturnType<typeof fakeRuns>) => runs.started.map((s) => s.ref)

describe('time triggers', () => {
  test('a cron slot starts one run with the slot as its ref, also after a restart', async () => {
    const w = world(at(8))
    w.setProtocols([proto('p1', { kind: 'time', cron: '0 9 * * *' })])
    const triggers = w.build()

    expect((await triggers.tick()).reconciled).toBe(true)
    w.state.now = at(9, 0, 1)
    expect((await triggers.tick()).started.time).toBe(1)
    w.state.now = at(9, 10)
    expect((await triggers.tick()).started.time).toBe(0)
    expect(startsOf(w.runs)).toEqual([`p1:${at(9)}`])

    // restart: a new trigger instance over the same store and cursor starts nothing for the same slot
    w.state.now = at(9, 20)
    const restarted = w.build()
    const report = await restarted.tick()
    expect(report.reconciled).toBe(true)
    expect(report.started.time).toBe(0)
    expect(w.runs.attempts.filter((a) => a.ref === `p1:${at(9)}`)).toHaveLength(1)
    const rows = (await w.schedules.list({})).items
    expect(rows.map((r) => r.id)).toEqual(['protocol:p1:v1'])
    expect(rows[0]?.nextFireAt).toBe(at(9) + 24 * HOUR)
  })

  test('a new version replaces the schedule; the old version never fires', async () => {
    const w = world(at(8))
    w.setProtocols([proto('p1', { kind: 'time', cron: '0 9 * * *' })])
    const triggers = w.build()
    await triggers.tick()

    w.setProtocols([proto('p1', { kind: 'time', cron: '0 10 * * *' }, { version: 2 })])
    w.state.now = at(8, 30)
    expect((await triggers.tick()).reconciled).toBe(true)
    expect((await w.schedules.list({})).items.map((r) => r.id)).toEqual(['protocol:p1:v2'])

    w.state.now = at(9, 0, 1)
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(0)

    w.state.now = at(10, 0, 1)
    await triggers.tick()
    expect(w.runs.started).toMatchObject([{ protocolId: 'p1', version: 2, ref: `p1:${at(10)}` }])
  })

  test('a one-shot `at` fires once; its row stays as the record of the version', async () => {
    const w = world(at(8))
    w.setProtocols([proto('p2', { kind: 'time', at: at(8, 30) })])
    const triggers = w.build()
    await triggers.tick()

    w.state.now = at(8, 31)
    expect((await triggers.tick()).started.time).toBe(1)
    expect(w.runs.started).toMatchObject([{ ref: `p2:${at(8, 30)}`, detail: { kind: 'time' } }])

    // restart after the fire: no second attempt for the same slot
    w.state.now = at(9)
    await w.build().tick()
    await w.build().tick()
    expect(w.runs.attempts).toHaveLength(1)
  })

  test('a disabled protocol loses its schedule', async () => {
    const w = world(at(8))
    w.setProtocols([proto('p1', { kind: 'time', cron: '0 9 * * *' })])
    const triggers = w.build()
    await triggers.tick()
    w.setProtocols([])
    await triggers.tick()
    expect((await w.schedules.list({})).items).toHaveLength(0)
  })
})

describe('absence', () => {
  test('fires once per absence period and re-arms after a sign', async () => {
    const w = world(T0)
    w.setLastSign('ana', T0 - 30 * MIN)
    w.setProtocols([
      proto(
        'p3',
        { kind: 'absence', person: 'ana', afterMs: HOUR },
        { savedAt: T0 - 2 * 24 * HOUR },
      ),
    ])
    const triggers = w.build()

    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(0)

    w.state.now = T0 + 31 * MIN
    expect((await triggers.tick()).started.absence).toBe(1)
    w.state.now = T0 + 40 * MIN
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual([`absence:${T0 - 30 * MIN}`])

    // a sign moves the anchor: the next absence period is a new run
    w.setLastSign('ana', T0 + 40 * MIN)
    w.state.now = T0 + 41 * MIN
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(1)

    w.state.now = T0 + 101 * MIN
    await triggers.tick()
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual([`absence:${T0 - 30 * MIN}`, `absence:${T0 + 40 * MIN}`])
  })

  test('a person who never signed is never absent', async () => {
    const w = world(T0)
    w.setProtocols([
      proto(
        'p3',
        { kind: 'absence', person: 'ana', afterMs: HOUR },
        { savedAt: T0 - 90 * 24 * HOUR },
      ),
    ])
    const triggers = w.build()
    w.state.now = T0 + 5 * HOUR
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(0)
  })

  test('a sign older than the protocol counts from the save, not from the old sign', async () => {
    const w = world(T0)
    w.setLastSign('ana', T0 - 10 * 24 * HOUR)
    w.setProtocols([
      proto('p3', { kind: 'absence', person: 'ana', afterMs: HOUR }, { savedAt: T0 }),
    ])
    const triggers = w.build()
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(0)
    w.state.now = T0 + HOUR + MIN
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual([`absence:${T0}`])
  })
})

describe('signal', () => {
  test('matches the type and the flat filter, and only from the save on', async () => {
    const w = world(T0)
    w.setProtocols([
      proto(
        'p4',
        { kind: 'signal', type: 'client.connected', filter: { clientId: 'c1' } },
        { savedAt: T0 - 1000 },
      ),
    ])
    const triggers = w.build()
    await triggers.tick()

    w.addSignal({
      id: 's0',
      personId: 'ana',
      clientId: 'c1',
      type: 'client.connected',
      at: T0 - 2000,
    })
    w.addSignal({
      id: 's1',
      personId: 'ana',
      clientId: 'c1',
      type: 'client.connected',
      at: T0 + 10,
    })
    w.addSignal({ id: 's2', personId: 'ana', clientId: 'c1', type: 'client.active', at: T0 + 11 })
    w.addSignal({
      id: 's3',
      personId: 'bob',
      clientId: 'c2',
      type: 'client.connected',
      at: T0 + 12,
    })
    w.state.now = T0 + 20
    expect((await triggers.tick()).started.signal).toBe(1)
    expect(startsOf(w.runs)).toEqual(['signal:s1'])

    // the cursor moved past the rows: a later tick replays nothing
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(1)
  })

  test('a person-owned protocol matches only its owner', async () => {
    const w = world(T0)
    w.setProtocols([
      proto(
        'p5',
        { kind: 'signal', type: 'client.connected' },
        { owner: 'ana', savedAt: T0 - 1000 },
      ),
    ])
    const triggers = w.build()
    await triggers.tick()
    w.addSignal({ id: 's1', personId: 'bob', clientId: 'c2', type: 'client.connected', at: T0 + 1 })
    w.addSignal({ id: 's2', personId: 'ana', clientId: 'c1', type: 'client.connected', at: T0 + 2 })
    w.state.now = T0 + 5
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual(['signal:s2'])
  })
})

describe('event', () => {
  test('afterMs starts the run at once with wakeAt = record time + afterMs', async () => {
    const w = world(T0)
    w.setProtocols([proto('p6', { kind: 'event', type: 'brain.amygdala.wait', afterMs: 60_000 })])
    const triggers = w.build()
    await triggers.tick()

    const row = w.addFeed('brain.amygdala.wait', { approvalId: 'a1' }, T0 + 5)
    w.state.now = T0 + 6
    expect((await triggers.tick()).started.event).toBe(1)
    expect(w.runs.started).toMatchObject([
      {
        // one run per approval: the ref names the approval, not the feed record
        ref: 'approval:a1',
        at: T0 + 5,
        detail: { kind: 'event', seq: row.seq, wakeAt: T0 + 5 + 60_000 },
      },
    ])
  })

  test('until waits for the payload time minus beforeMs; a record without that time starts nothing', async () => {
    const w = world(T0)
    w.setProtocols([
      proto('p7', {
        kind: 'event',
        type: 'brain.amygdala.wait',
        until: { field: 'expiresAt', beforeMs: HOUR },
      }),
    ])
    const triggers = w.build()
    await triggers.tick()

    w.addFeed('brain.amygdala.wait', { approvalId: 'a1', expiresAt: T0 + 2 * HOUR }, T0)
    w.addFeed('brain.amygdala.wait', { approvalId: 'a2' }, T0)
    await triggers.tick()
    expect(w.runs.started).toHaveLength(1)
    expect(w.runs.started[0]?.detail).toMatchObject({ wakeAt: T0 + HOUR })
    expect(w.warnings).toHaveLength(1)
  })

  test('the built-in approval-stale waits for the live ping; a stored beforeMs of it is not read', async () => {
    const approvalPing = {
      until: { field: 'expiresAt', beforeMs: 2 * HOUR },
      guard: { kind: 'approval.pending' as const },
    }
    const w = world(T0)
    w.setProtocols([
      proto('p8', { kind: 'event', type: 'brain.amygdala.wait', ...approvalPing } as Trigger, {
        builtIn: 'approval-stale',
      }),
      // the same trigger on an owner's protocol is taken as stored
      proto('p9', { kind: 'event', type: 'brain.amygdala.wait', ...approvalPing } as Trigger),
    ])
    const at5 = w.build(undefined, () => 5 * HOUR)
    await at5.tick()
    w.addFeed('brain.amygdala.wait', { approvalId: 'a1', expiresAt: T0 + 10 * HOUR }, T0)
    await at5.tick()
    const detailOf = (id: string) => w.runs.started.find((s) => s.protocolId === id)?.detail
    expect(detailOf('p8')).toMatchObject({ wakeAt: T0 + 5 * HOUR })
    expect(detailOf('p9')).toMatchObject({ wakeAt: T0 + 8 * HOUR })

    // a one-hour ping starts the next approval's built-in run at its expiry minus one hour
    const at1 = w.build(undefined, () => HOUR)
    w.addFeed('brain.amygdala.wait', { approvalId: 'a2', expiresAt: T0 + 10 * HOUR }, T0)
    await at1.tick()
    expect(
      w.runs.started.find((s) => s.protocolId === 'p8' && s.ref === 'approval:a2')?.detail,
    ).toMatchObject({ wakeAt: T0 + 9 * HOUR })
  })

  test('delivery.failed with the reminders source makes one run per delivery', async () => {
    const w = world(T0)
    w.setProtocols([
      proto('p8', {
        kind: 'event',
        type: 'delivery.failed',
        filter: { source: 'plugin:reminders' },
      }),
    ])
    const triggers = w.build()
    await triggers.tick()

    w.addFeed(
      'delivery.failed',
      { personId: 'ana', deliveryId: 'd1', source: 'plugin:reminders', reason: 'x' },
      T0,
    )
    w.addFeed(
      'delivery.failed',
      { personId: 'ana', deliveryId: 'd1', source: 'plugin:reminders', reason: 'x' },
      T0,
    )
    w.addFeed(
      'delivery.failed',
      { personId: 'ana', deliveryId: 'd2', source: 'other', reason: 'x' },
      T0,
    )
    const report = await triggers.tick()
    expect(report.started.event).toBe(1)
    expect(startsOf(w.runs)).toEqual(['delivery:d1'])
    expect(w.runs.attempts).toHaveLength(2)
  })

  test('a person-owned protocol sees only records about its owner', async () => {
    const w = world(T0)
    w.setProtocols([
      proto('p9', { kind: 'event', type: 'brain.broca.end' }, { owner: 'ana', savedAt: T0 - 1000 }),
    ])
    const triggers = w.build()
    await triggers.tick()
    const bob = w.addFeed('brain.broca.end', { personId: 'bob' }, T0)
    const ana = w.addFeed('brain.broca.end', { personId: 'ana' }, T0)
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual([`event:${ana.seq}`])
    expect(w.runs.started[0]?.ref).not.toBe(`event:${bob.seq}`)
  })

  test('records before the cursor are never replayed, and a failed start is retried once', async () => {
    const w = world(T0)
    w.setProtocols([proto('p6', { kind: 'event', type: 'brain.amygdala.wait' })])
    w.addFeed('brain.amygdala.wait', { n: 1 }, T0)
    w.addFeed('brain.amygdala.wait', { n: 2 }, T0)
    const triggers = w.build()
    await triggers.tick()
    expect(w.runs.attempts).toHaveLength(0)

    const third = w.addFeed('brain.amygdala.wait', { n: 3 }, T0)
    w.runs.failNext = 1
    await expect(triggers.tick()).rejects.toThrow('engine down')
    await triggers.tick()
    expect(startsOf(w.runs)).toEqual([`event:${third.seq}`])
  })

  test('a restart keeps the cursor: no replay, no loss', async () => {
    const w = world(T0)
    w.setProtocols([proto('p6', { kind: 'event', type: 'brain.amygdala.wait' })])
    const triggers = w.build()
    await triggers.tick()
    const first = w.addFeed('brain.amygdala.wait', {}, T0)
    await triggers.tick()

    const restarted = w.build()
    await restarted.tick()
    const second = w.addFeed('brain.amygdala.wait', {}, T0)
    await restarted.tick()
    expect(startsOf(w.runs)).toEqual([`event:${first.seq}`, `event:${second.seq}`])
    expect(w.settings.get(TRIGGER_CURSOR_KEY)).toMatchObject({ events: second.seq })
  })

  test('a pruned feed moves the cursor past the removed records', async () => {
    const w = world(T0)
    w.setProtocols([proto('p6', { kind: 'event', type: 'brain.amygdala.wait' })])
    const triggers = w.build()
    await triggers.tick()
    w.setPruned(5)
    w.addFeed('brain.amygdala.wait', {}, T0)
    await triggers.tick()
    expect(w.settings.get(TRIGGER_CURSOR_KEY)).toMatchObject({ events: 5 })
  })
})

describe('cursor store', () => {
  test('a stored value that is not a cursor reads as none', () => {
    const settings = new Map<string, unknown>([[TRIGGER_CURSOR_KEY, { events: -3 }]])
    const store = settingsCursorStore({
      get: <T>(key: string) => settings.get(key) as T | undefined,
      set: (key, value) => void settings.set(key, value),
    })
    expect(store.get()).toBeUndefined()
    store.set({ events: 4, signals: { at: T0, id: 'x' } })
    expect(store.get()).toEqual({ events: 4, signals: { at: T0, id: 'x' } })
  })
})
