import { describe, expect, test } from 'bun:test'
import type { ClientRecord } from '@keith/contracts'
import type { ActivityStore } from 'eharness/activity'
import { frontSessionId } from '../../platform/sessions.ts'
import {
  CLIENT_ACK_MS,
  type ClientTarget,
  createClientRoute,
  FEED_TEXT_MAX,
} from './client-route.ts'

// `callClient` (docs/specs/parietal.md, "Client capability registry and route"): the feed record on the person's front session,
// the ack from the same person and client only, one ack per call, and `unavailable` after the timeout (a fake clock).

interface Feed {
  type: string
  sessionId: string | null
  payload: Record<string, unknown>
}

function harness(clients: ClientRecord[]) {
  const feed: Feed[] = []
  const store = {
    append(record: Feed) {
      feed.push({ type: record.type, sessionId: record.sessionId, payload: record.payload })
      return Promise.resolve(record)
    },
  } as unknown as ActivityStore
  const timers: { run: () => void; cancelled: boolean }[] = []
  const route = createClientRoute({
    generations: { current: () => 0 },
    list: (personId) => clients.filter((c) => c.personId === personId),
    store,
    schedule: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  /** Runs every timer still pending (the fake clock reaching the ack window). */
  const fireTimers = (): void => {
    for (const timer of timers) if (!timer.cancelled) timer.run()
  }
  return { route, feed, timers, fireTimers }
}

const CLIENT_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ID = '00000000-0000-4000-8000-000000000002'

function client(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: CLIENT_ID,
    personId: 'ana',
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat', 'notify'],
    version: '0.1.0',
    firstSeenAt: 1,
    lastSeenAt: 1_000,
    lastActiveAt: 1_000,
    online: true,
    ...overrides,
  }
}

const target = (clientId = CLIENT_ID): ClientTarget => ({
  clientId,
  deliveryId: 'reminder:r1:fire-1',
  name: 'reminder',
})

/** Lets pending promise callbacks run (the call writes its feed record before it waits). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('callClient', () => {
  test('writes the feed record on the front session, clipped, and resolves with the ack result', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'x'.repeat(400) }, target())
    await flush()

    expect(h.feed).toHaveLength(1)
    const [record] = h.feed
    expect(record?.type).toBe('brain.parietal.deliver')
    expect(record?.sessionId).toBe(frontSessionId('ana', 0))
    expect(record?.payload).toMatchObject({
      region: 'parietal',
      clientId: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      capability: 'notify',
      name: 'reminder',
    })
    expect(String(record?.payload.text)).toHaveLength(FEED_TEXT_MAX)

    h.route.ack('ana', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'seen',
    })
    expect(await call).toEqual({ ok: true, result: 'seen' })
  })

  test('an ack without a result resolves ok with no result field', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    h.route.ack('ana', { id: CLIENT_ID, deliveryId: 'reminder:r1:fire-1', ok: true })
    expect(await call).toEqual({ ok: true })
  })

  test('no ack in the window is unavailable (the next route is tried)', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    expect(CLIENT_ACK_MS).toBe(10_000)
    h.fireTimers()
    expect(await call).toEqual({ ok: false, reason: 'unavailable' })
  })

  test('an ack from another person is ignored and the call still waits', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    h.route.ack('ben', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'mine',
    })
    h.route.ack('ana', {
      id: OTHER_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'wrong client',
    })
    h.fireTimers()
    expect(await call).toEqual({ ok: false, reason: 'unavailable' })
  })

  test('a second ack is ignored', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    h.route.ack('ana', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'first',
    })
    h.route.ack('ana', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'second',
    })
    expect(await call).toEqual({ ok: true, result: 'first' })
  })

  test('an ack from another person does not use up the one shot: the client ack after it still answers', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    h.route.ack('ben', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'stranger',
    })
    h.route.ack('ana', {
      id: CLIENT_ID,
      deliveryId: 'reminder:r1:fire-1',
      ok: true,
      result: 'mine',
    })
    expect(await call).toEqual({ ok: true, result: 'mine' })
  })

  test('no reachable client of the person (none at all) is unavailable and writes nothing', async () => {
    const h = harness([])
    expect(await h.route.callClient('ana', 'notify', { text: 'hi' }, target())).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(h.feed).toHaveLength(0)
    expect(h.timers).toHaveLength(0)
  })

  test('a client that acks ok:false is unavailable', async () => {
    const h = harness([client()])
    const call = h.route.callClient('ana', 'notify', { text: 'hi' }, target())
    await flush()
    h.route.ack('ana', { id: CLIENT_ID, deliveryId: 'reminder:r1:fire-1', ok: false })
    expect(await call).toEqual({ ok: false, reason: 'unavailable' })
  })

  test('a client without the capability, or offline, is never asked', async () => {
    const withoutNotify = harness([client({ capabilities: ['chat'] })])
    expect(await withoutNotify.route.callClient('ana', 'notify', { text: 'hi' }, target())).toEqual(
      { ok: false, reason: 'unavailable' },
    )
    expect(withoutNotify.feed).toHaveLength(0)

    const offline = harness([client({ online: false })])
    expect(await offline.route.callClient('ana', 'notify', { text: 'hi' }, target())).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(offline.feed).toHaveLength(0)
  })

  test('a client of another person is never asked', async () => {
    const h = harness([client({ personId: 'ben' })])
    expect(await h.route.callClient('ana', 'notify', { text: 'hi' }, target())).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(h.feed).toHaveLength(0)
  })

  test('an input that does not parse is refused before anything is written', async () => {
    const h = harness([client()])
    const tooLong = { text: 'x'.repeat(501) }
    expect(await h.route.callClient('ana', 'notify', tooLong, target())).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(h.feed).toHaveLength(0)
  })
})
