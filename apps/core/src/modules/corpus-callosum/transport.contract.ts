// The reusable contract of a room transport (ADR-0026 §6, docs/specs/corpus-callosum.md "Transport"). Any adapter (text now,
// audio and video later) runs `transportContract` with its own harness. This file is not a test file: each adapter's test
// file imports it and calls it.
import { describe, expect, test } from 'bun:test'
import type { RoomTransport } from '@keith/contracts'

export interface FeedRecord {
  type: string
  sessionId: string | null
  payload: Record<string, unknown>
}

export interface TranscriptLine {
  seq: number
  kind: string
  speaker: string | null
  text: string | null
}

/**
 * What an adapter test provides. The harness does the store side (the caller's job in production): `open` creates a room with
 * `members` active (the first one initiates) and `outsider` never invited; `acceptInStore` and `leaveInStore` move a member the
 * way the lifecycle service does. `feed` and `transcript` read back what the adapter wrote.
 */
export interface TransportHarness {
  transport: RoomTransport
  open(members: readonly string[], outsider: string): string
  acceptInStore(roomId: string, personId: string): void
  leaveInStore(roomId: string, personId: string): void
  feed(): FeedRecord[]
  transcript(roomId: string): TranscriptLine[]
}

const recipients = (records: FeedRecord[]): string[] =>
  records.map((r) => String(r.payload.to)).sort()

export function transportContract(name: string, create: () => TransportHarness): void {
  describe(`room transport contract: ${name}`, () => {
    test('say writes one line and one feed record per active member, none for a non-member', async () => {
      const h = create()
      const room = h.open(['ana', 'bob'], 'dee')
      const before = h.feed().length
      await h.transport.say(room, 'ana', 'hello room')
      const line = h.transcript(room).at(-1)
      expect(line).toMatchObject({ kind: 'say', speaker: 'ana', text: 'hello room' })
      const fresh = h.feed().slice(before)
      expect(recipients(fresh)).toEqual(['ana', 'bob'])
      expect(fresh.every((r) => r.type === 'room.event')).toBe(true)
      expect(fresh.every((r) => r.sessionId === null)).toBe(true)
    })

    test('a feed record names the room and the transcript position and carries no text', async () => {
      const h = create()
      const room = h.open(['ana', 'bob'], 'dee')
      await h.transport.say(room, 'bob', 'a secret phrase')
      const seq = h.transcript(room).at(-1)?.seq
      for (const record of h.feed()) {
        expect(Object.keys(record.payload).sort()).toEqual(['roomId', 'seq', 'to'])
        expect(record.payload).toMatchObject({ roomId: room, seq })
      }
      expect(JSON.stringify(h.feed())).not.toContain('a secret phrase')
    })

    test('Keith speaks as the keith speaker of a keith line', async () => {
      const h = create()
      const room = h.open(['ana'], 'dee')
      await h.transport.say(room, 'keith', 'Here is my answer')
      expect(h.transcript(room).at(-1)).toMatchObject({ kind: 'keith', speaker: 'keith' })
    })

    test('a member who left gets no later record; the others still do', async () => {
      const h = create()
      const room = h.open(['ana', 'bob', 'cy'], 'dee')
      await h.transport.leave(room, 'bob', 'left')
      h.leaveInStore(room, 'bob')
      const before = h.feed().length
      await h.transport.say(room, 'ana', 'still here')
      expect(recipients(h.feed().slice(before))).toEqual(['ana', 'cy'])
    })

    test('a joined member gets the records from then on', async () => {
      const h = create()
      const room = h.open(['ana'], 'dee')
      h.acceptInStore(room, 'bob')
      await h.transport.join(room, 'bob')
      expect(h.transcript(room).at(-1)).toMatchObject({ kind: 'join', speaker: 'bob' })
      const before = h.feed().length
      await h.transport.say(room, 'ana', 'welcome')
      expect(recipients(h.feed().slice(before))).toEqual(['ana', 'bob'])
    })

    test('end writes one end line and one record to each member still active', async () => {
      const h = create()
      const room = h.open(['ana', 'bob'], 'dee')
      const before = h.feed().length
      await h.transport.end(room, 'done')
      expect(h.transcript(room).at(-1)).toMatchObject({ kind: 'end', speaker: null })
      expect(recipients(h.feed().slice(before))).toEqual(['ana', 'bob'])
    })

    test('an outsider never receives a record, however many lines are written', async () => {
      const h = create()
      const room = h.open(['ana', 'bob'], 'dee')
      for (let i = 0; i < 3; i += 1) await h.transport.say(room, 'ana', `line ${i}`)
      expect(recipients(h.feed())).not.toContain('dee')
    })
  })
}
