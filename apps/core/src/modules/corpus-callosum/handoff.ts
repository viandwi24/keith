// The private handoff of a room (docs/specs/corpus-callosum.md, "Private requests and results"; ADR-0026 §3, ADR-0020 §2). The
// room tool `room_handoff` sends the speaker's own request to the speaker's front session through the P25 delivery service:
// a wake turn whose principal is the speaker (the front route, `modules/delivery/route-front.ts`). The room records only that
// the speaker asked in their own chat; the request text never enters the room, its transcript, or an audit row.
import type { DeliveryFailReason } from '@keith/contracts'
import type { RoomsRepo } from '@keith/db'
import type { Audit, RoomDelivery } from './ports.ts'
import type { TextRoomTransport } from './transport-text.ts'

/** The `eh.event` name the front agent sees for a handoff. */
export const HANDOFF_NAME = 'room-handoff'
/** Who asks, for the delivery row. */
export const HANDOFF_SOURCE = 'room:handoff'
/** The most characters of the speaker's request a handoff takes. */
export const HANDOFF_REQUEST_MAX = 1000
/** The transcript line of a handoff: the only text the room learns of it. */
export const HANDOFF_LINE = 'asked in their own chat'
/** What Keith answers in the room after a handoff (the tool result tells the model to say it). */
export const HANDOFF_REPLY = 'I will do it in your own chat.'

/** The text the front session receives: the room's name and the speaker's own request, with the instruction to report back. */
export function handoffText(roomName: string, request: string): string {
  return `From room "${roomName}": ${request}. Do it in this chat. When done, ask whether to share the result with the room.`
}

export interface HandoffInput {
  roomId: string
  speakerId: string
  /** The seq of the line whose turn runs now: the dedupe key of the handoff (`<roomId>:<seq>`). */
  seq: number
  /** The speaker's own request, as the turn passed it to the tool. */
  request: string
}

/**
 * `handed`: the request went to the speaker's front session (or waits there for a route); `repeat`: the same turn already
 * handed one over, nothing is sent again; `failed`: the delivery did not reach the speaker (a terminal refusal).
 */
export type HandoffOutcome =
  | { status: 'handed' }
  | { status: 'repeat' }
  | { status: 'failed'; reason: DeliveryFailReason }

export interface RoomHandoff {
  hand(input: HandoffInput): Promise<HandoffOutcome>
}

export interface HandoffDeps {
  rooms: Pick<RoomsRepo, 'get'>
  delivery: RoomDelivery
  transport: Pick<TextRoomTransport, 'handoff'>
  audit: Pick<Audit, 'record'>
}

/**
 * The handoff. The delivery is exactly once by its run id (`<roomId>:<seq>`), so a repeat inject is refused by the delivery
 * itself; the set of handled keys keeps the room line and the audit row to one per key in this process. A failed delivery
 * leaves the key free, so a later call of the same turn may try again.
 */
export function createRoomHandoff(deps: HandoffDeps): RoomHandoff {
  const handled = new Set<string>()

  return {
    async hand({ roomId, speakerId, seq, request }) {
      const key = `${roomId}:${seq}`
      if (handled.has(key)) return { status: 'repeat' }
      const room = deps.rooms.get(roomId)
      if (room === undefined) throw new Error('no such room')
      handled.add(key)
      let outcome: Awaited<ReturnType<RoomDelivery['deliver']>>
      try {
        outcome = await deps.delivery.deliver({
          id: key,
          source: HANDOFF_SOURCE,
          to: speakerId,
          name: HANDOFF_NAME,
          text: handoffText(room.name, request),
          needs: { mode: 'wake' },
        })
      } catch (error) {
        handled.delete(key)
        throw error
      }
      if (outcome.status === 'failed') {
        handled.delete(key)
        return { status: 'failed', reason: outcome.reason }
      }
      await deps.transport.handoff(roomId, speakerId)
      deps.audit.record({
        kind: 'room.handoff',
        actor: speakerId,
        via: 'local',
        detail: { roomId, subject: speakerId },
      })
      return { status: 'handed' }
    },
  }
}

/**
 * The seq of the line whose turn runs in each room. The turn pipeline sets it before the turn and clears it after; the room
 * tools read it, so `room_handoff` keys its handoff by the line that started the turn. One turn runs per room at a time.
 */
export interface RoomTurnSeqs {
  set(roomId: string, seq: number): void
  clear(roomId: string): void
  of(roomId: string): number | undefined
}

export function createRoomTurnSeqs(): RoomTurnSeqs {
  const seqs = new Map<string, number>()
  return {
    set: (roomId, seq) => {
      seqs.set(roomId, seq)
    },
    clear: (roomId) => {
      seqs.delete(roomId)
    },
    of: (roomId) => seqs.get(roomId),
  }
}
