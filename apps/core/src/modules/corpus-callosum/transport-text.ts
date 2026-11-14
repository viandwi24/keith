// The text transport of a shared room (ADR-0026 §6, docs/specs/corpus-callosum.md "Transport"). It implements the port
// `RoomTransport` of @keith/contracts: it writes the room's events through the room repo, fans out one `room.event` feed
// record per active member (the record carries no text), and holds the indicator state in memory. Both collaborators come
// in by injection: the repo (packages/db) and the activity store (eharness).
import {
  ROOM_EVENT,
  ROOM_INDICATOR,
  type RoomIndicator,
  type RoomTransport,
} from '@keith/contracts'
import type { EventData, EventKind, RoomsRepo } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import { HANDOFF_LINE } from './handoff.ts'

/** The part of the activity store the transport writes to: one `append`, as the plugin feed does. */
export type RoomActivity = Pick<ActivityStore, 'append'>

/** One feed record of a room event: the person named in `to`, the room, and the transcript position. Never text. */
export interface RoomFeedNotice {
  to: string
  roomId: string
  seq: number
}

/** One feed record of an indicator change: the person named in `to` and the room. No indicator value, no text. */
export interface RoomIndicatorNotice {
  to: string
  roomId: string
}

/**
 * The feed writer of rooms (RoomFeed): one `room.event` record per `notify`, one `room.indicator` record per `notifyIndicator`.
 * A failed write is logged and dropped, as the plugin feed does: an event never fails the operation that emitted it.
 */
export interface RoomFeed {
  notify(notice: RoomFeedNotice): Promise<void>
  notifyIndicator(notice: RoomIndicatorNotice): Promise<void>
}

export function createRoomFeed(options: {
  activity: RoomActivity
  warn?: ((message: string) => void) | undefined
}): RoomFeed {
  const publish = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await options.activity.append({ type, sessionId: null, agentId: null, payload })
    } catch (error) {
      options.warn?.(
        `corpus-callosum: could not publish ${type}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    notify: (notice) =>
      publish(ROOM_EVENT, { to: notice.to, roomId: notice.roomId, seq: notice.seq }),
    notifyIndicator: (notice) => publish(ROOM_INDICATOR, { to: notice.to, roomId: notice.roomId }),
  }
}

/** The transport of a text room: the port, plus the line writer that returns the seq and the indicator the TUI reads (in memory). */
export interface TextRoomTransport extends RoomTransport {
  /**
   * Writes one line (`keith` for Keith's own) and fans it out; returns its seq. `data` is the line's flat JSON (the turn
   * markers: `queued`, `refused`, and `answers` on a Keith answer). The room service and the turn pipeline use it.
   */
  sayLine(roomId: string, from: string | 'keith', text: string, data?: EventData): Promise<number>
  /**
   * Writes a `post` line: a person's own text, shared with the room by that person's confirmation (`post.ts`). The speaker is
   * the person; the line fans out to the active members like any other. Returns its seq.
   */
  postLine(roomId: string, personId: string, text: string): Promise<number>
  /**
   * Writes a `handoff` line: the speaker asked in their own chat (`handoff.ts`). The line is the fixed text `HANDOFF_LINE`, never
   * the request. Returns its seq.
   */
  handoff(roomId: string, personId: string): Promise<number>
  /**
   * The indicator last set for the room; `idle` when none was set. A change of it writes one `room.indicator` record per
   * active member (`indicator`); the state itself stays in memory.
   */
  indicatorOf(roomId: string): RoomIndicator
}

export interface TextTransportOptions {
  rooms: Pick<RoomsRepo, 'appendEvent' | 'members'>
  activity: RoomActivity
  /** Epoch ms of each transcript line. Defaults to `Date.now`. */
  now?: () => number
  warn?: (message: string) => void
}

const LEAVE_KIND = { left: 'leave', removed: 'remove', ended: 'end' } as const satisfies Record<
  Parameters<RoomTransport['leave']>[2],
  EventKind
>

/**
 * The text adapter. Call order, which the lifecycle service follows (corpus-callosum.md "Transport"):
 * - `join` after the repo has made the person `active` (the joiner is then a recipient);
 * - `leave` and `end` before the repo changes the status (the leaving person and the members still active get the record;
 *   after the change they get no further records).
 * `say` writes the line and fans out at once. Recipients are the members whose status is `active` at the call; a
 * non-member is never a recipient. The caller checks that the speaker may speak (the service does, not the adapter).
 * `indicator` fans out a `room.indicator` record to the active members only when the state changes.
 */
export function createTextTransport(options: TextTransportOptions): TextRoomTransport {
  const now = options.now ?? Date.now
  const feed = createRoomFeed({ activity: options.activity, warn: options.warn })
  const indicators = new Map<string, RoomIndicator>()

  const write = async (
    roomId: string,
    line: { kind: EventKind; speaker: string | null; text: string | null; data?: EventData },
  ): Promise<number> => {
    const seq = options.rooms.appendEvent({ roomId, at: now(), ...line })
    const active = options.rooms.members(roomId).filter((member) => member.status === 'active')
    await Promise.all(active.map((member) => feed.notify({ to: member.personId, roomId, seq })))
    return seq
  }

  return {
    async join(roomId, personId) {
      await write(roomId, { kind: 'join', speaker: personId, text: null })
    },
    async leave(roomId, personId, reason) {
      await write(roomId, {
        kind: LEAVE_KIND[reason],
        speaker: personId,
        text: null,
        data: { reason },
      })
    },
    async say(roomId, from, text) {
      await write(roomId, { kind: from === 'keith' ? 'keith' : 'say', speaker: from, text })
    },
    sayLine(roomId, from, text, data) {
      return write(roomId, {
        kind: from === 'keith' ? 'keith' : 'say',
        speaker: from,
        text,
        ...(data === undefined ? {} : { data }),
      })
    },
    postLine(roomId, personId, text) {
      return write(roomId, { kind: 'post', speaker: personId, text })
    },
    handoff(roomId, personId) {
      return write(roomId, { kind: 'handoff', speaker: personId, text: HANDOFF_LINE })
    },
    async indicator(roomId, state) {
      const previous = indicators.get(roomId) ?? { kind: 'idle' }
      if (JSON.stringify(previous) === JSON.stringify(state)) return
      indicators.set(roomId, state)
      const active = options.rooms.members(roomId).filter((member) => member.status === 'active')
      await Promise.all(
        active.map((member) => feed.notifyIndicator({ to: member.personId, roomId })),
      )
    },
    async end(roomId, reason) {
      await write(roomId, { kind: 'end', speaker: null, text: null, data: { reason } })
    },
    indicatorOf(roomId) {
      return indicators.get(roomId) ?? { kind: 'idle' }
    },
  }
}
