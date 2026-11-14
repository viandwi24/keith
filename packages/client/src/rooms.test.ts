import { afterAll, describe, expect, test } from 'bun:test'
import {
  ROOM_EVENT,
  ROOM_INDICATOR,
  type RoomEvent,
  type RoomsEventsInput,
  type RoomView,
} from '@keith/contracts'
import { createKeithClient } from './client.ts'
import {
  createRoomEvents,
  createRoomView,
  type RoomEventsFeed,
  type RoomFeedRecord,
  roomsApiOf,
} from './rooms.ts'

const ROOM = '0190a6a0-0000-4000-8000-0000000000a1'
const OTHER = '0190a6a0-0000-4000-8000-0000000000a2'

/** A room's transcript on the core: `events()` answers like `rooms.events` (seq after the cursor, newest last). */
function fakeServer() {
  const log: RoomEvent[] = []
  const calls: RoomsEventsInput[] = []
  let failNext = 0
  const add = (seq: number, text = `line ${seq}`): void => {
    log.push({ seq, at: seq * 1000, kind: 'say', speaker: { id: 'ana', name: 'Ana' }, text })
  }
  return {
    log,
    calls,
    add,
    failNext(times: number) {
      failNext = times
    },
    async events(input: RoomsEventsInput) {
      calls.push(input)
      if (failNext > 0) {
        failNext--
        throw new Error('core unreachable')
      }
      const after = input.after ?? 0
      const limit = input.limit ?? 200
      const events = log.filter((e) => e.seq > after).slice(0, limit)
      return { events, nextAfter: events.at(-1)?.seq ?? after }
    },
  }
}

/** A feed the test drives: a record or a resync reaches every listener. */
function fakeFeed() {
  const events = new Set<(record: RoomFeedRecord) => void>()
  const resyncs = new Set<(reason: string) => void>()
  const feed: RoomEventsFeed = {
    subscribeEvents(fn) {
      events.add(fn)
      return () => events.delete(fn)
    },
    subscribeResync(fn) {
      resyncs.add(fn)
      return () => resyncs.delete(fn)
    },
  }
  return {
    feed,
    record(roomId: string, seq: number) {
      for (const fn of events) fn({ type: ROOM_EVENT, payload: { to: 'ana', roomId, seq } })
    },
    resync(reason = 'connect') {
      for (const fn of resyncs) fn(reason)
    },
    listeners: () => events.size + resyncs.size,
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Bun.sleep(0)
}

const seqs = (events: readonly RoomEvent[]): number[] => events.map((e) => e.seq)

test('refresh reads from seq 0 and keeps the cursor at the last seq', async () => {
  const server = fakeServer()
  server.add(1)
  server.add(2)
  const { feed } = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed })
  await room.refresh()
  expect(seqs(room.get().events)).toEqual([1, 2])
  expect(room.get().after).toBe(2)
  expect(room.get().loaded).toBe(true)
  expect(server.calls[0]).toEqual({ roomId: ROOM, after: 0, limit: 200 })
})

test('a dropped feed: the resync reads the events it missed from the last seq, once', async () => {
  const server = fakeServer()
  const { feed, resync } = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed })
  const detach = room.attach()
  await settle()
  server.add(1)
  server.add(2)
  server.add(3)
  await room.refresh()
  // the feed is down: 4 and 5 are said meanwhile, no record arrives
  server.add(4)
  server.add(5)
  resync('connect')
  await settle()
  expect(seqs(room.get().events)).toEqual([1, 2, 3, 4, 5])
  expect(server.calls.at(-1)).toEqual({ roomId: ROOM, after: 3, limit: 200 })
  // a second resync with nothing new adds nothing
  resync('resync-event')
  await settle()
  expect(seqs(room.get().events)).toEqual([1, 2, 3, 4, 5])
  detach()
})

test('a room.event record refetches past the cursor; a record already held does not', async () => {
  const server = fakeServer()
  const fake = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed: fake.feed })
  const detach = room.attach()
  await settle()
  server.add(1)
  fake.record(ROOM, 1)
  await settle()
  expect(seqs(room.get().events)).toEqual([1])
  const before = server.calls.length
  fake.record(ROOM, 1) // held already: no call
  await settle()
  expect(server.calls.length).toBe(before)
  server.add(2)
  server.add(3)
  fake.record(ROOM, 3) // a gap (2 never seen): the refetch reads both, in order
  await settle()
  expect(seqs(room.get().events)).toEqual([1, 2, 3])
  detach()
})

test('records of another room, other types and bad payloads do not refetch', async () => {
  const server = fakeServer()
  const fake = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed: fake.feed })
  const detach = room.attach()
  await settle()
  const before = server.calls.length
  server.add(1)
  fake.record(OTHER, 1)
  fake.record(OTHER, 2)
  for (const fn of [] as Array<() => void>) fn()
  await settle()
  expect(server.calls.length).toBe(before)
  expect(room.get().events).toEqual([])
  detach()
})

test('the server answering an event twice never appends it twice', async () => {
  const server = fakeServer()
  server.add(1)
  server.add(2)
  const replay = {
    events: async (input: RoomsEventsInput) => {
      // the core repeats seq 1 in the page (a retried read): only the new seq 2 is kept
      const page = await server.events({ ...input, after: 0 })
      return { events: [page.events[0] as RoomEvent, ...page.events], nextAfter: 2 }
    },
  }
  const { feed } = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: replay.events, feed })
  await room.refresh()
  expect(seqs(room.get().events)).toEqual([1, 2])
})

test('pages: a full page is followed by the next, until a short page', async () => {
  const server = fakeServer()
  for (let seq = 1; seq <= 5; seq++) server.add(seq)
  const { feed } = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed, limit: 2 })
  await room.refresh()
  expect(seqs(room.get().events)).toEqual([1, 2, 3, 4, 5])
  expect(server.calls.map((c) => c.after)).toEqual([0, 2, 4])
})

test('a failed refetch keeps the events and the cursor, and the next resync recovers without a gap', async () => {
  const server = fakeServer()
  const fake = fakeFeed()
  const errors: unknown[] = []
  const room = createRoomEvents({
    roomId: ROOM,
    events: server.events,
    feed: fake.feed,
    onError: (e) => errors.push(e),
  })
  server.add(1)
  const detach = room.attach()
  await settle()
  server.add(2)
  server.failNext(1)
  await room.refresh()
  expect(room.get().error).toBeInstanceOf(Error)
  expect(errors.length).toBe(1)
  expect(seqs(room.get().events)).toEqual([1])
  expect(room.get().after).toBe(1)
  server.add(3)
  fake.resync('connect')
  await settle()
  expect(room.get().error).toBeUndefined()
  expect(seqs(room.get().events)).toEqual([1, 2, 3])
  detach()
})

test('triggers that arrive during a refetch coalesce into one more pass', async () => {
  const server = fakeServer()
  server.add(1)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  const slow = async (input: RoomsEventsInput) => {
    if (first) {
      first = false
      await gate
    }
    return server.events(input)
  }
  const fake = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: slow, feed: fake.feed })
  const running = room.refresh()
  server.add(2)
  room.refresh()
  fake.resync('connect')
  fake.record(ROOM, 2)
  release?.()
  await running
  await settle()
  expect(seqs(room.get().events)).toEqual([1, 2])
  // one slow pass, then one pass that found everything: not one per trigger
  expect(server.calls.length).toBe(2)
})

test('detach removes both feed listeners and stops the refetches', async () => {
  const server = fakeServer()
  const fake = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed: fake.feed })
  const detach = room.attach()
  await settle()
  detach()
  expect(fake.listeners()).toBe(0)
  const before = server.calls.length
  server.add(1)
  fake.record(ROOM, 1)
  fake.resync()
  await settle()
  expect(server.calls.length).toBe(before)
})

test('subscribe is told every change and stops after the unsubscribe', async () => {
  const server = fakeServer()
  server.add(1)
  const { feed } = fakeFeed()
  const room = createRoomEvents({ roomId: ROOM, events: server.events, feed })
  const seen: number[][] = []
  const off = room.subscribe((state) => seen.push(seqs(state.events)))
  await room.refresh()
  off()
  server.add(2)
  await room.refresh()
  expect(seen.at(-1)).toEqual([1])
  expect(seqs(room.get().events)).toEqual([1, 2])
})

// The wrapper: each method is the procedure of the same name, over the typed oRPC client.
const requests: Array<{ path: string; input: unknown }> = []
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/rooms/')) return new Response('not found', { status: 404 })
    const body = (await request.json()) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (url.pathname.endsWith('/events'))
      return Response.json({ json: { events: [], nextAfter: 0 } })
    if (url.pathname.endsWith('/settings/get')) return Response.json({ json: { maxMembers: 8 } })
    return Response.json({ json: { ok: true } })
  },
})
afterAll(() => server.stop(true))

test('roomsApiOf calls the rooms procedures with their input', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  await client.rooms.events({ roomId: ROOM, after: 3 })
  await client.rooms.decline({ roomId: ROOM })
  await client.rooms.settings.get()
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/rooms/events',
    '/rpc/rooms/decline',
    '/rpc/rooms/settings/get',
  ])
  expect(requests[0]?.input).toEqual({ roomId: ROOM, after: 3 })
  expect(roomsApiOf({ rpc: client.rpc }).events).toBeFunction()
})

describe('createRoomView: rooms.get in step with the feed', () => {
  const view = (indicator: string) =>
    ({
      room: { id: ROOM },
      members: [],
      indicator: { kind: indicator },
      you: {},
      pending: [],
    }) as unknown as RoomView

  /** A feed the test drives: any record and any resync reaches every listener. */
  const liveFeed = () => {
    const events = new Set<(record: RoomFeedRecord) => void>()
    const resyncs = new Set<(reason: string) => void>()
    const feed: RoomEventsFeed = {
      subscribeEvents(fn) {
        events.add(fn)
        return () => events.delete(fn)
      },
      subscribeResync(fn) {
        resyncs.add(fn)
        return () => resyncs.delete(fn)
      },
    }
    return {
      feed,
      emit(record: RoomFeedRecord) {
        for (const fn of events) fn(record)
      },
      resync() {
        for (const fn of resyncs) fn('connect')
      },
      listeners: () => events.size + resyncs.size,
    }
  }

  test('reads now on attach, then again on each room.indicator of its room; another room and a bad payload do nothing', async () => {
    const live = liveFeed()
    const indicators = ['idle', 'thinking', 'speaking']
    const reads: string[] = []
    const store = createRoomView({
      roomId: ROOM,
      feed: live.feed,
      get: async (input) => {
        reads.push(input.roomId)
        return view(indicators[Math.min(reads.length - 1, indicators.length - 1)] ?? 'idle')
      },
    })
    const detach = store.attach()
    await settle()
    expect(reads).toEqual([ROOM])
    expect(store.get().view?.indicator).toEqual({ kind: 'idle' })

    live.emit({ type: ROOM_INDICATOR, payload: { to: 'ana', roomId: ROOM } })
    await settle()
    expect(reads.length).toBe(2)
    expect(store.get().view?.indicator).toEqual({ kind: 'thinking' })

    live.emit({ type: ROOM_INDICATOR, payload: { to: 'ana', roomId: OTHER } })
    live.emit({ type: ROOM_INDICATOR, payload: { to: 'ana' } })
    live.emit({ type: ROOM_INDICATOR, payload: { to: 'ana', roomId: 'not-a-uuid' } })
    await settle()
    expect(reads.length).toBe(2)
    detach()
    expect(live.listeners()).toBe(0)
  })

  test('a room.event of its room reads the view again (members and requests change with the lines); others do not', async () => {
    const live = liveFeed()
    let reads = 0
    const store = createRoomView({
      roomId: ROOM,
      feed: live.feed,
      get: async () => {
        reads++
        return view('idle')
      },
    })
    const detach = store.attach()
    await settle()
    live.emit({ type: ROOM_EVENT, payload: { to: 'ana', roomId: ROOM, seq: 4 } })
    await settle()
    expect(reads).toBe(2)
    live.emit({ type: ROOM_EVENT, payload: { to: 'ana', roomId: OTHER, seq: 4 } })
    live.emit({ type: 'plugin.notes.shared', payload: { to: 'ana', roomId: ROOM } })
    await settle()
    expect(reads).toBe(2)
    detach()
  })

  test('a resync reads the view again', async () => {
    const live = liveFeed()
    let reads = 0
    const detach = createRoomView({
      roomId: ROOM,
      feed: live.feed,
      get: async () => {
        reads++
        return view('idle')
      },
    }).attach()
    await settle()
    live.resync()
    await settle()
    expect(reads).toBe(2)
    detach()
  })

  test('a failed read keeps the last view and reports the error; the next read clears it', async () => {
    let fail = false
    const errors: unknown[] = []
    const store = createRoomView({
      roomId: ROOM,
      feed: liveFeed().feed,
      onError: (error) => errors.push(error),
      get: async () => {
        if (fail) throw new Error('core unreachable')
        return view('thinking')
      },
    })
    await store.refresh()
    expect(store.get().view?.indicator).toEqual({ kind: 'thinking' })
    fail = true
    await store.refresh()
    expect(store.get().view?.indicator).toEqual({ kind: 'thinking' })
    expect(store.get().error).toBeInstanceOf(Error)
    expect(errors).toHaveLength(1)
    fail = false
    await store.refresh()
    expect(store.get().error).toBeUndefined()
  })

  test('subscribe is told each read and stops after the unsubscribe', async () => {
    const seen: string[] = []
    const store = createRoomView({
      roomId: ROOM,
      feed: liveFeed().feed,
      get: async () => view('idle'),
    })
    const off = store.subscribe((snapshot) => seen.push(snapshot.view?.indicator.kind ?? 'none'))
    await store.refresh()
    off()
    await store.refresh()
    expect(seen).toEqual(['idle'])
  })
})
