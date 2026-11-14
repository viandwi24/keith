import { describe, expect, test } from 'bun:test'
import { createConnectionMonitor, type LinkState, type MonitorClock } from './connection-monitor.ts'

/** A clock driven by hand. */
function fakeClock(): MonitorClock & { advance(ms: number): Promise<void>; active(): number } {
  let time = 1_000
  let n = 0
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => time,
    after(ms, fn) {
      const id = n++
      timers.set(id, { due: time + ms, fn })
      return () => {
        timers.delete(id)
      }
    },
    active: () => timers.size,
    async advance(ms) {
      const end = time + ms
      for (;;) {
        let first: [number, { due: number; fn: () => void }] | undefined
        for (const e of timers)
          if (e[1].due <= end && (!first || e[1].due < first[1].due)) first = e
        if (!first) break
        time = first[1].due
        timers.delete(first[0])
        first[1].fn()
        for (let i = 0; i < 10; i++) await Promise.resolve()
      }
      time = end
    },
  }
}

const setup = (diagnose?: () => Promise<string | undefined>) => {
  const clock = fakeClock()
  const restarts: number[] = []
  const monitor = createConnectionMonitor({
    clock,
    restart: () => restarts.push(clock.now()),
    ...(diagnose === undefined ? {} : { diagnose }),
  })
  const seen: LinkState[] = []
  monitor.subscribe((s) => seen.push(s))
  return { clock, restarts, monitor, seen }
}
const S = 1000

describe('connection monitor', () => {
  test('the first connect is not an outage: connecting stays connecting, then live', async () => {
    const { monitor, clock } = setup()
    monitor.feedStatus('connecting')
    await clock.advance(60 * S)
    expect(monitor.get().kind).toBe('connecting')
    expect(clock.active()).toBe(0)
    monitor.feedStatus('live')
    expect(monitor.get().kind).toBe('live')
    expect(clock.active()).toBe(0) // no timer while live
  })

  test('the exact cycle: drop, reconnecting 5 s, disconnected 15 s, attempt 5 s, disconnected 15 s, attempt, live', async () => {
    const { monitor, clock, restarts } = setup()
    monitor.feedStatus('live')
    const t0 = clock.now()
    monitor.feedStatus('connecting')
    expect(monitor.get()).toMatchObject({ kind: 'reconnecting', until: t0 + 5 * S })
    await clock.advance(4 * S)
    expect(monitor.get().kind).toBe('reconnecting')
    await clock.advance(1 * S)
    expect(monitor.get()).toMatchObject({ kind: 'disconnected', retryAt: t0 + 20 * S })
    expect(restarts).toHaveLength(0)
    await clock.advance(14 * S)
    expect(monitor.get().kind).toBe('disconnected')
    await clock.advance(1 * S) // t0 + 20: the attempt
    expect(restarts).toEqual([t0 + 20 * S])
    expect(monitor.get()).toMatchObject({ kind: 'reconnecting', attempts: 1, until: t0 + 25 * S })
    // the feed's own churn during the attempt changes nothing
    monitor.feedStatus('stopped')
    monitor.feedStatus('connecting')
    expect(monitor.get().kind).toBe('reconnecting')
    await clock.advance(5 * S)
    expect(monitor.get()).toMatchObject({ kind: 'disconnected', retryAt: t0 + 40 * S })
    await clock.advance(15 * S)
    expect(restarts).toEqual([t0 + 20 * S, t0 + 40 * S])
    // never faster than the 20 s cycle (15 s wait + 5 s attempt)
    monitor.feedStatus('live')
    expect(monitor.get()).toEqual({ kind: 'live', attempts: 0 })
    expect(clock.active()).toBe(0)
    await clock.advance(120 * S)
    expect(restarts).toHaveLength(2)
  })

  test('the feed coming back by itself while disconnected is enough', async () => {
    const { monitor, clock } = setup()
    monitor.feedStatus('live')
    monitor.feedStatus('polling')
    await clock.advance(5 * S)
    expect(monitor.get().kind).toBe('disconnected')
    monitor.feedStatus('live')
    expect(monitor.get().kind).toBe('live')
    expect(clock.active()).toBe(0)
  })

  test('the reason from the diagnosis is added to the disconnected state; a failing diagnosis adds none', async () => {
    const a = setup(async () => 'connection refused')
    a.monitor.feedStatus('live')
    a.monitor.feedStatus('connecting')
    await a.clock.advance(5 * S)
    expect(a.monitor.get()).toMatchObject({ kind: 'disconnected', reason: 'connection refused' })
    const b = setup(() => Promise.reject(new Error('boom')))
    b.monitor.feedStatus('live')
    b.monitor.feedStatus('connecting')
    await b.clock.advance(5 * S)
    expect(b.monitor.get().kind).toBe('disconnected')
    expect(b.monitor.get().reason).toBeUndefined()
  })

  test('a late diagnosis never lands on a later state', async () => {
    let release: (r: string) => void = () => {}
    const { monitor, clock } = setup(() => new Promise((r) => (release = r)))
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    await clock.advance(5 * S)
    monitor.feedStatus('live')
    release('connection refused')
    await clock.advance(1)
    expect(monitor.get()).toEqual({ kind: 'live', attempts: 0 })
  })

  test('retryNow starts an attempt at once while disconnected, at most once per 3 s', async () => {
    const { monitor, clock, restarts } = setup()
    expect(monitor.retryNow()).toBe(false) // not disconnected
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    expect(monitor.retryNow()).toBe(false) // reconnecting already
    await clock.advance(5 * S)
    expect(monitor.retryNow()).toBe(true)
    expect(restarts).toHaveLength(1)
    expect(monitor.get()).toMatchObject({ kind: 'reconnecting', attempts: 1 })
    // the attempt still obeys its 5 s window
    await clock.advance(5 * S)
    expect(monitor.get().kind).toBe('disconnected')
    // 5 s after the first retry: allowed again; but within 3 s of one it is refused
    expect(monitor.retryNow()).toBe(true)
    await clock.advance(5 * S)
    expect(monitor.get().kind).toBe('disconnected')
    expect(monitor.retryNow()).toBe(true)
    expect(monitor.retryNow()).toBe(false)
    expect(restarts).toHaveLength(3)
  })

  test('retryNow refused inside 3 s of the previous one', async () => {
    const { monitor, clock } = setup()
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    await clock.advance(5 * S)
    expect(monitor.retryNow()).toBe(true)
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    await clock.advance(5 * S)
    expect(monitor.get().kind).toBe('disconnected')
    await clock.advance(1)
    expect(monitor.retryNow()).toBe(true) // 5 s later
  })

  test('logged out is terminal: no timer, no retries, no way back, retryNow does nothing', async () => {
    const { monitor, clock, restarts } = setup()
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    monitor.feedStatus('unauthorized')
    expect(monitor.get().kind).toBe('logged-out')
    expect(clock.active()).toBe(0)
    monitor.feedStatus('live')
    expect(monitor.retryNow()).toBe(false)
    await clock.advance(120 * S)
    expect(monitor.get().kind).toBe('logged-out')
    expect(restarts).toHaveLength(0)
  })

  test('refused while disconnected also stops the retries', async () => {
    const { monitor, clock, restarts } = setup()
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    await clock.advance(5 * S)
    monitor.feedStatus('unauthorized')
    expect(monitor.get().kind).toBe('logged-out')
    await clock.advance(120 * S)
    expect(restarts).toHaveLength(0)
    expect(clock.active()).toBe(0)
  })

  test('stop clears every timer and ignores later input', async () => {
    const { monitor, clock, restarts } = setup()
    monitor.feedStatus('live')
    monitor.feedStatus('connecting')
    expect(clock.active()).toBe(1)
    monitor.stop()
    expect(clock.active()).toBe(0)
    monitor.feedStatus('live')
    await clock.advance(120 * S)
    expect(monitor.get().kind).toBe('reconnecting')
    expect(restarts).toHaveLength(0)
  })

  test('subscribe gives the state at once and stops when unsubscribed', () => {
    const { monitor, seen } = setup()
    expect(seen.map((s) => s.kind)).toEqual(['connecting'])
    const more: string[] = []
    const off = monitor.subscribe((s) => more.push(s.kind))
    monitor.feedStatus('live')
    off()
    monitor.feedStatus('connecting')
    expect(more).toEqual(['connecting', 'live'])
  })
})
