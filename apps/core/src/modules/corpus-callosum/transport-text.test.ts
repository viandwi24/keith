import { describe, expect, test } from 'bun:test'
import { ROOM_INDICATOR } from '@keith/contracts'
import { migrateDatabase, openDatabase, roomsRepo } from '@keith/db'
import type { ActivityInput } from 'eharness/activity'
import { type FeedRecord, type TransportHarness, transportContract } from './transport.contract.ts'
import {
  createRoomFeed,
  createTextTransport,
  type RoomActivity,
  type TextRoomTransport,
} from './transport-text.ts'

// The text transport (docs/specs/corpus-callosum.md "Transport"). Real SQLite store and room repo; the activity store is a
// recorder. The shared contract runs first, then what only the text adapter does: the indicator and the failure rule.

const T0 = 1_000

function world(options: { failFeed?: boolean } = {}) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const rooms = roomsRepo(sqlite)
  const records: FeedRecord[] = []
  const warnings: string[] = []
  let clock = T0
  const activity: RoomActivity = {
    append: (input: ActivityInput | readonly ActivityInput[]) => {
      if (options.failFeed) return Promise.reject(new Error('feed down'))
      for (const r of Array.isArray(input) ? input : [input]) {
        records.push({
          type: r.type,
          sessionId: r.sessionId ?? null,
          payload: r.payload as Record<string, unknown>,
        })
      }
      return Promise.resolve([])
    },
  }
  const transport = createTextTransport({
    rooms,
    activity,
    now: () => {
      clock += 1
      return clock
    },
    warn: (message) => warnings.push(message),
  })
  let roomSeq = 0
  const harness: TransportHarness & { transport: TextRoomTransport } = {
    transport,
    open(members, _outsider) {
      roomSeq += 1
      const id = `room-${roomSeq}`
      const [initiator, ...rest] = members
      if (initiator === undefined) throw new Error('a room needs an initiator')
      rooms.create(
        {
          id,
          name: id,
          initiator,
          answerMode: 'addressed',
          windowMinutes: 30,
          windowEvents: 200,
        },
        T0,
      )
      for (const person of rest) {
        rooms.invite(id, person, initiator, T0)
        rooms.accept(id, person, T0)
      }
      return id
    },
    acceptInStore(roomId, personId) {
      rooms.invite(roomId, personId, rooms.get(roomId)?.initiator ?? personId, T0)
      rooms.accept(roomId, personId, T0)
    },
    leaveInStore(roomId, personId) {
      rooms.leave(roomId, personId, 'left', 'left', T0)
    },
    feed: () => records,
    transcript(roomId) {
      return rooms.eventsForOwner(roomId, 0, 1000).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        speaker: e.speaker,
        text: e.text,
      }))
    },
  }
  return { harness, records, warnings, rooms }
}

transportContract('text', () => world().harness)

describe('text transport: indicator', () => {
  const indicated = (records: FeedRecord[], roomId: string) =>
    records
      .filter((r) => r.type === ROOM_INDICATOR && r.payload.roomId === roomId)
      .map((r) => r.payload.to)
      .sort()

  test('is idle until set, per room, and never writes a line', async () => {
    const { harness, rooms } = world()
    const a = harness.open(['ana', 'bob'], 'dee')
    const b = harness.open(['cy'], 'dee')
    expect(harness.transport.indicatorOf(a)).toEqual({ kind: 'idle' })
    const linesBefore = rooms.eventsForOwner(a, 0, 1000).length
    await harness.transport.indicator(a, { kind: 'thinking' })
    await harness.transport.indicator(a, { kind: 'speaking', to: 'ana' })
    expect(harness.transport.indicatorOf(a)).toEqual({ kind: 'speaking', to: 'ana' })
    expect(harness.transport.indicatorOf(b)).toEqual({ kind: 'idle' })
    expect(rooms.eventsForOwner(a, 0, 1000).length).toBe(linesBefore)
  })

  test('a change writes one room.indicator per active member, naming them and the room only', async () => {
    const { harness, records, rooms } = world()
    const a = harness.open(['ana', 'bob'], 'dee')
    rooms.invite(a, 'eve', 'ana', T0) // invited, not active: no record
    await harness.transport.indicator(a, { kind: 'thinking' })
    expect(indicated(records, a)).toEqual(['ana', 'bob'])
    const change = records.find((r) => r.type === ROOM_INDICATOR)
    expect(change?.payload).toEqual({ to: 'ana', roomId: a })
    expect(change?.sessionId).toBeNull()
    expect(JSON.stringify(records.filter((r) => r.type === ROOM_INDICATOR))).not.toContain(
      'thinking',
    )
  })

  test('the same state again writes nothing; a change writes again', async () => {
    const { harness, records } = world()
    const a = harness.open(['ana', 'bob'], 'dee')
    await harness.transport.indicator(a, { kind: 'thinking' })
    const once = records.length
    await harness.transport.indicator(a, { kind: 'thinking' })
    expect(records.length).toBe(once)
    await harness.transport.indicator(a, { kind: 'idle' })
    expect(records.length).toBe(once + 2)
  })

  test('a member who left gets no further records; an outsider never gets one', async () => {
    const { harness, records } = world()
    const a = harness.open(['ana', 'bob'], 'dee')
    harness.leaveInStore(a, 'bob')
    await harness.transport.indicator(a, { kind: 'listening', who: 'ana' })
    expect(indicated(records, a)).toEqual(['ana'])
    expect(records.some((r) => r.payload.to === 'dee')).toBe(false)
  })
})

describe('text transport: feed failures', () => {
  test('a failed feed write is logged and dropped; the line is still written', async () => {
    const { harness, warnings } = world({ failFeed: true })
    const room = harness.open(['ana', 'bob'], 'dee')
    await expect(harness.transport.say(room, 'ana', 'still written')).resolves.toBeUndefined()
    expect(harness.transcript(room).at(-1)).toMatchObject({ kind: 'say', text: 'still written' })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('room.event')
  })
})

describe('createRoomFeed', () => {
  test('notify appends one room.event record with exactly to, roomId and seq', async () => {
    const seen: ActivityInput[] = []
    const feed = createRoomFeed({
      activity: {
        append: (input) => {
          seen.push(input as ActivityInput)
          return Promise.resolve([])
        },
      },
    })
    await feed.notify({ to: 'ana', roomId: 'room-x', seq: 7 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'room.event',
      sessionId: null,
      payload: { to: 'ana', roomId: 'room-x', seq: 7 },
    })
  })
})
