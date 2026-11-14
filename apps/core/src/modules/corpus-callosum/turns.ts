// The turn pipeline of a shared room (docs/specs/corpus-callosum.md "The room session and the principal of each turn", "Transport";
// ADR-0026 §2 and §3, ADR-0020 §3). `rooms.say` stores the line through the room service, decides whether it addresses Keith,
// queues it behind the turn that runs, and runs one turn at a time per room. Each turn is sent with the speaker as its
// principal, on the room's session (`room:<roomId>:g<generation>`) under the shared lock, and is billed to that speaker.
// A room never uses wake: a turn only starts from a message.
import { ROOM_TEXT_MAX, type RoomsSayOutput } from '@keith/contracts'
import type { EventData, RoomRecord, RoomsRepo } from '@keith/db'
import type { HarnessAgent, HarnessUIMessage, SessionLock, StopReason } from 'eharness'
import type { Budget } from '../budget/index.ts'
import { FRONT_TURN_BUDGET_USD } from '../budget/index.ts'
import { FALLBACK_LINES } from '../prefrontal/index.ts'
import type { RoomTurnSeqs } from './handoff.ts'
import type { RoomActivity, RoomCaller, RoomService } from './service.ts'
import { RoomError, roomSessionId } from './service.ts'
import type { RoomSettingsReader } from './settings.ts'
import type { TextRoomTransport } from './transport-text.ts'

/** The error text of a message refused by the queue bound (`rooms.maxQueue`); the transcript keeps the line with `refused`. */
export const ROOM_BUSY = 'room is busy'
/** The error text of a message refused by the hourly turn limit (`rooms.maxTurnsPerHour`). */
export const ROOM_TURN_LIMIT = 'the room has reached its turn limit for this hour'
/** Keith's line to a speaker whose monthly budget cannot cover one turn: no turn runs. Fixed text, no data. */
export const NO_BUDGET_NOTICE = 'You have no budget left for me in this room.'
/** Keith's line when a turn ended on its cost cap before it answered. */
export const COST_CAP_NOTICE = 'The budget ran out before I could answer.'
/** Keith's line when a turn ended without an answer for any other reason: the `professional` line, the default of a test without a persona. */
export const ANSWER_FAILED_NOTICE = FALLBACK_LINES.answerFailed

/** The mention rule of `addressed` mode: the text starts with `keith` or `@keith` (corpus-callosum.md, "Who is addressed"). */
const ADDRESSED = /^@?keith\b/i
const HOUR_MS = 60 * 60_000

/** One message waiting for its turn: the speaker, the say row it answers (`seq`) and the text the turn is sent. */
export interface TurnItem {
  roomId: string
  speakerId: string
  seq: number
  text: string
}

/** The turn state of one room in this process: whether a turn runs, the waiting messages, the turns accepted in the last hour. */
interface Lane {
  running: boolean
  waiting: TurnItem[]
  accepted: number[]
}

export interface RoomTurnsOptions {
  /** The room agent (`createRoomAgent`): its turns are sent through `agent.session(id, { lock })`. */
  agent: HarnessAgent
  lock: SessionLock
  service: Pick<RoomService, 'say'>
  rooms: Pick<RoomsRepo, 'get' | 'member' | 'window' | 'bumpGeneration'>
  transport: Pick<TextRoomTransport, 'sayLine' | 'indicator'>
  /** The speaker's budget: a turn needs `FRONT_TURN_BUDGET_USD` left (the same reservation the agent makes). */
  budget: Pick<Budget, 'statusOf'>
  settings: Pick<RoomSettingsReader, 'maxQueue' | 'maxTurnsPerHour'>
  /** The brain event of a turn (`brain.corpus-callosum.turn`), on the room's session: no text. */
  activity?: RoomActivity
  /** The notice of a turn whose answer failed, read when it is written (the persona's line: `prefrontal/lines.ts`). */
  answerFailedLine?: () => string
  /** The seq of the line each turn answers, set for the turn's run: the handoff key of `room_handoff` (`handoff.ts`). */
  turnSeqs?: Pick<RoomTurnSeqs, 'set' | 'clear'>
  now?: () => number
  warn?: (message: string) => void
}

export interface RoomTurns {
  /**
   * A member's line (`rooms.say`). Stores it through the room service with its turn marker, refuses it when the queue or the
   * hourly limit is full (the line stays in the transcript, marked `refused`), and queues a message that addresses Keith.
   * Resolves once the line is stored; the answer comes later as a Keith line.
   */
  say(
    caller: RoomCaller,
    roomId: string,
    text: string,
    replyToKeith?: boolean,
  ): Promise<RoomsSayOutput>
  /** Whether a turn runs in the room now or messages are waiting for one. */
  busy(roomId: string): boolean
  /**
   * Boot recovery (`recoverRooms`, compose-sessions.ts): a queued message that no Keith answer followed runs again, once. It
   * was accepted by an earlier process, so the queue bound and the hourly limit do not count it again.
   */
  redrive(item: TurnItem): void
  /**
   * Graceful stop: no further message of the queue starts, and a turn that the agent's close interrupts writes no answer. A
   * queued message keeps `data.queued` without an answer, so the next boot runs it (corpus-callosum.md, "Recovery").
   */
  halt(): void
}

/** Whether a line addresses Keith: every line in `every` mode; else `keith`/`@keith` at the start, or a reply to a Keith line. */
export function addressedOf(
  room: Pick<RoomRecord, 'answerMode'>,
  text: string,
  replyToKeith: boolean | undefined,
): boolean {
  return room.answerMode === 'every' || replyToKeith === true || ADDRESSED.test(text)
}

/** The last assistant message of a turn, as plain text (the answer), trimmed; empty when it has no text part. */
export function answerOf(messages: readonly HarnessUIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  return (last?.parts ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

/** The first `max` characters (code points) of a text: an answer over the transcript limit is cut, never refused. */
const clipText = (text: string, max: number): string => [...text].slice(0, max).join('')

export function createRoomTurns(options: RoomTurnsOptions): RoomTurns {
  const { agent, lock, service, rooms, transport, budget, settings } = options
  const now = options.now ?? Date.now
  const warn = options.warn ?? (() => {})
  const failedLine = options.answerFailedLine ?? (() => ANSWER_FAILED_NOTICE)
  const lanes = new Map<string, Lane>()
  let halted = false

  const laneOf = (roomId: string): Lane => {
    const have = lanes.get(roomId)
    if (have !== undefined) return have
    const lane: Lane = { running: false, waiting: [], accepted: [] }
    lanes.set(roomId, lane)
    return lane
  }

  /** The refusal of a new addressed message, or undefined when it may queue. Read before the line is stored. */
  const refusalOf = (lane: Lane, at: number, busy: boolean): RoomError | undefined => {
    if (busy && lane.waiting.length >= settings.maxQueue())
      return new RoomError('TOO_MANY_REQUESTS', ROOM_BUSY)
    lane.accepted = lane.accepted.filter((t) => t > at - HOUR_MS)
    if (lane.accepted.length >= settings.maxTurnsPerHour())
      return new RoomError('TOO_MANY_REQUESTS', ROOM_TURN_LIMIT)
    return undefined
  }

  /**
   * A message that arrives after the room was idle longer than `window_minutes` starts a new generation: a new session id with
   * the window block alone (corpus-callosum.md, "Generation rollover"). Read before the line is stored, since the line itself
   * is in the window once stored. Never during a turn: the turn that runs keeps the session it started on.
   */
  const idleWindow = (roomId: string, at: number): boolean => rooms.window(roomId, at).length === 0

  /** Keith's line, marked as the answer of the say row `seq` (recovery never retries an answered message). */
  const answer = (roomId: string, text: string, seq: number): Promise<number> =>
    transport.sayLine(roomId, 'keith', text, { answers: seq })

  const brainTurn = (
    roomId: string,
    generation: number,
    speakerId: string,
    stop: StopReason | undefined,
  ): void => {
    options.activity?.record(roomSessionId(roomId, generation), 'brain.corpus-callosum.turn', {
      roomId,
      speakerId,
      ...(stop === undefined ? {} : { stop }),
    })
  }

  /**
   * One turn for one queued message. It never throws: a failure is a Keith line, and the queue goes on. A speaker who is no
   * longer an active member, or a room that has ended, gets no turn (nothing runs for them).
   */
  const runTurn = async (item: TurnItem): Promise<void> => {
    try {
      const room = rooms.get(item.roomId)
      const member = rooms.member(item.roomId, item.speakerId)
      if (room === undefined || room.state === 'ended' || member?.status !== 'active') return
      const session = roomSessionId(room.id, room.generation)

      const remaining = budget.statusOf(item.speakerId).remainingUsd
      if (remaining !== null && remaining < FRONT_TURN_BUDGET_USD) {
        await answer(room.id, NO_BUDGET_NOTICE, item.seq)
        brainTurn(room.id, room.generation, item.speakerId, undefined)
        return
      }

      await transport.indicator(room.id, { kind: 'thinking' })
      let stop: StopReason
      let text = ''
      options.turnSeqs?.set(room.id, item.seq)
      try {
        const run = agent
          .session(session, { lock })
          .send(item.text, { principal: { id: item.speakerId } })
        const result = await run.result
        stop = result.stop
        text = answerOf(result.messages)
      } catch (error) {
        stop = 'error'
        warn(`rooms: turn failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        options.turnSeqs?.clear(room.id)
      }

      // a turn stopped by the graceful stop writes no answer: the message stays queued for the next boot
      if (stop === 'interrupted' || (halted && stop === 'error')) {
        brainTurn(room.id, room.generation, item.speakerId, stop)
        return
      }
      if (text !== '') {
        await transport.indicator(room.id, { kind: 'speaking', to: item.speakerId })
        await answer(room.id, clipText(text, ROOM_TEXT_MAX), item.seq)
      } else if (stop === 'cost-cap') {
        await answer(room.id, COST_CAP_NOTICE, item.seq)
      } else if (stop !== 'complete') {
        await answer(room.id, failedLine(), item.seq)
      }
      brainTurn(room.id, room.generation, item.speakerId, stop)
    } catch (error) {
      warn(`rooms: turn not finished: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Runs the waiting messages of a room one after another. Only one loop per room runs at a time. */
  const drain = (roomId: string): void => {
    const lane = laneOf(roomId)
    if (lane.running) return
    lane.running = true
    void (async () => {
      for (
        let next = lane.waiting.shift();
        next !== undefined && !halted;
        next = lane.waiting.shift()
      ) {
        await runTurn(next)
      }
      // `running` drops before any await: a message that arrives now starts a new loop
      lane.running = false
      void transport.indicator(roomId, { kind: 'idle' })
    })()
  }

  return {
    async say(caller, roomId, text, replyToKeith) {
      const room = rooms.get(roomId)
      if (room === undefined) throw new RoomError('NOT_FOUND', 'no such room')
      const lane = laneOf(roomId)
      const at = now()
      const addressed = addressedOf(room, text, replyToKeith)
      const busy = lane.running
      // decided before the write, so the line carries its marker; the service checks the speaker first
      const refusal = addressed ? refusalOf(lane, at, busy) : undefined
      const data: EventData | undefined =
        refusal !== undefined ? { refused: true } : busy && addressed ? { queued: true } : undefined
      // a message into an idle room starts the next generation, once the line is stored (the service checked the speaker)
      const rolls = refusal === undefined && !busy && idleWindow(roomId, at)
      const seq = await service.say(caller, roomId, text, data)
      if (refusal !== undefined) throw refusal
      if (rolls) rooms.bumpGeneration(roomId)
      if (addressed) {
        lane.accepted.push(at)
        lane.waiting.push({ roomId, speakerId: caller.by, seq, text })
        if (busy) void transport.indicator(roomId, { kind: 'listening', who: caller.by })
        else drain(roomId)
      }
      return { seq, queued: addressed && busy, addressed }
    },

    busy(roomId) {
      const lane = lanes.get(roomId)
      return lane !== undefined && (lane.running || lane.waiting.length > 0)
    },

    redrive(item) {
      laneOf(item.roomId).waiting.push(item)
      drain(item.roomId)
    },

    halt() {
      halted = true
    },
  }
}
