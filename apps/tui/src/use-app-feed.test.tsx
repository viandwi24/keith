import { afterEach, describe, expect, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import { IDENTITY_CHANGED } from '@keith/contracts'
import { cleanup, render } from '@keith/ui/testing'
import { Text } from 'ink'
import { type AppFeedInput, useAppFeed } from './use-app-feed.ts'

afterEach(cleanup)

/** A feed the test drives by hand: the handlers the hook subscribes to. */
function fakeClient() {
  const records: Array<(record: unknown) => void> = []
  const resyncs: Array<() => void> = []
  const client = {
    feed: () => ({
      subscribeEvents: (fn: (record: unknown) => void) => {
        records.push(fn)
        return () => {}
      },
      subscribeResync: (fn: () => void) => {
        resyncs.push(fn)
        return () => {}
      },
      start: () => {},
      stop: () => {},
    }),
  } as unknown as KeithClient
  return {
    client,
    emit: (record: { type: string; payload?: unknown }) => {
      for (const fn of records)
        fn({ seq: 1, sessionId: null, agentId: null, payload: {}, createdAt: 0, ...record })
    },
    resync: () => {
      for (const fn of resyncs) fn()
    },
  }
}

function mount(overrides: Partial<AppFeedInput> = {}) {
  const feed = fakeClient()
  const counts = { identity: 0, budget: 0 }
  const input: AppFeedInput = {
    client: feed.client,
    trace: { current: null },
    push: () => {},
    resyncBrain: () => {},
    applyTask: () => {},
    applyNode: () => {},
    reloadTasks: () => {},
    reloadNodes: () => {},
    reloadBudget: () => {
      counts.budget += 1
    },
    reloadIdentity: () => {
      counts.identity += 1
    },
    connection: 'live',
    ...overrides,
  }
  function Feed() {
    useAppFeed(input)
    return <Text>feed</Text>
  }
  render(<Feed />, { columns: 40, rows: 2 })
  return { feed, counts }
}

describe('useAppFeed identity', () => {
  test('an identity.changed record reads whoami once, other records do not', async () => {
    const { feed, counts } = mount()
    await Bun.sleep(5)
    feed.emit({ type: IDENTITY_CHANGED, payload: { personId: 'p1', reason: 'grant' } })
    expect(counts.identity).toBe(1)
    feed.emit({ type: 'budget-changed', payload: { status: {} } })
    expect(counts.identity).toBe(1)
    expect(counts.budget).toBe(1)
  })

  test('a resync reads whoami as before', async () => {
    const { feed, counts } = mount()
    await Bun.sleep(5)
    const before = counts.identity
    feed.resync()
    expect(counts.identity).toBe(before + 1)
  })

  test('a resync forgets the dream run on the Brain panel, before it refetches', async () => {
    const calls: string[] = []
    const { feed } = mount({
      resyncBrain: () => {
        calls.push('brain')
      },
      reloadTasks: () => {
        calls.push('tasks')
      },
    })
    await Bun.sleep(5)
    feed.resync()
    expect(calls).toEqual(['brain', 'tasks'])
  })
})
