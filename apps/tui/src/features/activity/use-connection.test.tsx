import { afterEach, describe, expect, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import { cleanup, type ManualScheduler, manualScheduler, render } from '@keith/ui/testing'
import { Text } from 'ink'
import { type ConnectionState, useConnection } from './use-connection.ts'

afterEach(cleanup)

type Status = 'idle' | 'connecting' | 'live' | 'polling' | 'stopped' | 'unauthorized'

/** The part of an eharness feed the monitor uses, driven by hand. */
function fakeFeed() {
  let status: Status = 'connecting'
  const listeners = new Set<(s: { status: Status }) => void>()
  const calls: string[] = []
  return {
    calls,
    set(next: Status) {
      status = next
      for (const fn of [...listeners]) fn({ status })
    },
    subscribers: () => listeners.size,
    feed: {
      get: () => ({ status }),
      subscribe(run: (s: { status: Status }) => void) {
        listeners.add(run)
        run({ status })
        return () => {
          listeners.delete(run)
        }
      },
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
    },
  }
}

function setup(reachable: boolean) {
  const f = fakeFeed()
  const client = {
    feed: () => f.feed,
    rpc: {
      health: {
        get: () =>
          reachable ? Promise.resolve({}) : Promise.reject(new TypeError('fetch failed')),
      },
    },
  } as unknown as KeithClient
  const clock = manualScheduler()
  let last: ConnectionState | undefined
  function Probe() {
    last = useConnection(client, { windowMs: 5_000, waitMs: 15_000 }, clock)
    return <Text>{last.kind}</Text>
  }
  const view = render(<Probe />, { columns: 40, rows: 3 })
  const now = () => last
  return { f, clock, view, now }
}

const settle = async (clock: ManualScheduler, ms: number) => {
  clock.advance(ms)
  await Bun.sleep(5)
}

describe('useConnection', () => {
  test('live, drop, reconnecting 5 s, disconnected 15 s, attempt 5 s, disconnected 15 s, attempt, live', async () => {
    const { f, clock, now } = setup(false)
    f.set('live')
    await Bun.sleep(5)
    expect(now()?.kind).toBe('live')
    f.set('connecting')
    await Bun.sleep(5)
    expect(now()).toMatchObject({ kind: 'reconnecting', until: 5_000 })
    await settle(clock, 5_000)
    expect(now()).toMatchObject({ kind: 'disconnected', retryAt: 5_000 + 15_000 })
    expect(f.calls).toEqual([])
    await settle(clock, 15_000)
    expect(f.calls).toEqual(['stop', 'start'])
    expect(now()).toMatchObject({ kind: 'reconnecting', until: 25_000 })
    await settle(clock, 5_000)
    expect(now()?.kind).toBe('disconnected')
    await settle(clock, 15_000)
    expect(f.calls).toEqual(['stop', 'start', 'stop', 'start'])
    f.set('live')
    await Bun.sleep(5)
    expect(now()).toMatchObject({ kind: 'live', loggedOut: false })
    expect(clock.active()).toBe(0) // nothing runs while live
  })

  test('the reason of the failed health call is on the disconnected state, without the address', async () => {
    const { f, clock, now } = setup(false)
    f.set('live')
    f.set('connecting')
    await settle(clock, 5_000)
    await Bun.sleep(10)
    expect(now()).toMatchObject({ kind: 'disconnected', reason: 'network error' })
  })

  test('retry starts an attempt now, once per 3 s', async () => {
    const { f, clock, now } = setup(false)
    f.set('live')
    f.set('connecting')
    await settle(clock, 5_000)
    expect(now()?.retry()).toBe(true)
    expect(f.calls).toEqual(['stop', 'start'])
    await Bun.sleep(5)
    expect(now()?.kind).toBe('reconnecting')
  })

  test('a refused credential is logged out and nothing is retried', async () => {
    const { f, clock, now } = setup(false)
    f.set('live')
    f.set('connecting')
    f.set('unauthorized')
    await Bun.sleep(5)
    expect(now()).toMatchObject({ kind: 'logged-out', loggedOut: true })
    await settle(clock, 120_000)
    expect(f.calls).toEqual([])
    expect(clock.active()).toBe(0)
  })

  test('unmount stops the timers and leaves the feed', async () => {
    const { f, clock, view } = setup(false)
    f.set('live')
    f.set('connecting')
    await Bun.sleep(5)
    expect(clock.active()).toBe(1)
    expect(f.subscribers()).toBe(1)
    view.unmount()
    expect(clock.active()).toBe(0)
    expect(f.subscribers()).toBe(0)
  })
})
