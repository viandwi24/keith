// The room tools of the room agent (docs/specs/corpus-callosum.md, "The room agent", "Tools"; ADR-0026 §3 and §5). None takes a
// person id: the person of a call is the turn's principal, read through `speakerOf` at the start of every tool. A turn with no
// principal, or a principal who is not an active member of the room named by the session id, has no rights and is refused.
// The tools take their collaborators by injection; the tests pass the real repo and service over SQLite with fakes for presence.
import { ROOM_TEXT_MAX } from '@keith/contracts'
import type { EventRecord, RoomRecord, RoomsRepo } from '@keith/db'
import { type Tool, tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import {
  HANDOFF_REPLY,
  HANDOFF_REQUEST_MAX,
  type RoomHandoff,
  type RoomTurnSeqs,
} from './handoff.ts'
import type { RoomPeople, RoomPresence } from './ports.ts'
import type { RoomService } from './service.ts'
import type { TextRoomTransport } from './transport-text.ts'

export const ROOM_SAY_TOOL = 'room_say'
export const ROOM_PRESENCE_TOOL = 'room_presence'
export const ROOM_ACTIVITY_TOOL = 'room_activity'
export const ROOM_LEAVE_TOOL = 'room_leave'
export const ROOM_REQUEST_REMOVE_TOOL = 'room_request_remove'
export const ROOM_REQUEST_END_TOOL = 'room_request_end'
export const ROOM_HANDOFF_TOOL = 'room_handoff'

/** The room tools of this module, in the order the room agent offers them. */
export const ROOM_TOOLS = [
  ROOM_SAY_TOOL,
  ROOM_PRESENCE_TOOL,
  ROOM_ACTIVITY_TOOL,
  ROOM_LEAVE_TOOL,
  ROOM_REQUEST_REMOVE_TOOL,
  ROOM_REQUEST_END_TOOL,
  ROOM_HANDOFF_TOOL,
] as const

/** The error a tool answers to a speaker who is neither the initiator nor the owner (the model sees it as the tool's error). */
export const NOT_ALLOWED = 'not allowed'
/** The reason written to `room.turn.refused` for that refusal. */
export const NOT_ALLOWED_REASON = 'not-initiator-or-owner'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A room session: `room:<roomId>:g<generation>` (corpus-callosum.md, "The room session"). */
const ROOM_SESSION = new RegExp(`^room:(${UUID}):g(\\d+)$`, 'i')

/** The room id of a room session id, or undefined for any other id. */
export function roomIdOfSession(sessionId: string | null | undefined): string | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  return ROOM_SESSION.exec(sessionId)?.[1]
}

/** One call of a room tool, as the turn made it: the tool, the principal it saw (none for a turn without one) and the room. */
export interface RoomToolCall {
  tool: string
  principalId: string | undefined
  roomId: string | undefined
}

/** The room tools' collaborators: the room repo and service, the presence port, the text transport and the people directory. */
export interface RoomToolDeps {
  rooms: Pick<RoomsRepo, 'get' | 'member' | 'members' | 'window'>
  service: Pick<RoomService, 'leave' | 'requestRemove' | 'requestEnd' | 'turnRefused'>
  presence: RoomPresence
  transport: Pick<TextRoomTransport, 'sayLine'>
  people: Pick<RoomPeople, 'get'>
  /** The private handoff to the speaker's own chat (`handoff.ts`, `room_handoff`). */
  handoff: Pick<RoomHandoff, 'hand'>
  /** The seq of the line whose turn runs in the room: the handoff's dedupe key. */
  turnSeqs: Pick<RoomTurnSeqs, 'of'>
  now?: () => number
  /** Test seam (the recorder of `createRoomAgent`): called at the start of every room tool call, before its checks. */
  onToolCall?: (call: RoomToolCall) => void
}

/** The speaker of a call: the active member the turn runs for, and the room. */
export interface Speaker {
  roomId: string
  personId: string
  room: RoomRecord
}

/** What a room tool answers about one transcript line (no room id, no internal fields). */
export interface RoomLine {
  seq: number
  at: number
  kind: EventRecord['kind']
  speaker: string | null
  speakerName: string | null
  text: string | null
}

export const SPEAKER_REFUSAL = 'no speaker'
/** The error of a handoff with no turn running in the room (never reached by a turn; a test seam guard). */
export const NO_TURN_REFUSAL = 'no turn'

/**
 * The speaker of a room call: the principal of the turn, who must be an active member of the room named by the session id.
 * Throws `no speaker` otherwise, so no room tool runs for a turn without a person or for a person outside the room.
 */
export function speakerOf(deps: Pick<RoomToolDeps, 'rooms'>, ctx: HarnessContext): Speaker {
  const roomId = roomIdOfSession(ctx.session.id)
  const personId = ctx.principal?.id
  if (roomId === undefined || personId === undefined) throw new Error(SPEAKER_REFUSAL)
  const member = deps.rooms.member(roomId, personId)
  if (member?.status !== 'active') throw new Error(SPEAKER_REFUSAL)
  const room = deps.rooms.get(roomId)
  if (room === undefined || room.state === 'ended') throw new Error(SPEAKER_REFUSAL)
  return { roomId, personId, room }
}

const SayInput = z.object({ text: z.string().min(1).max(ROOM_TEXT_MAX) })
const ActivityInput = z.object({ minutes: z.number().int().min(1).max(240).optional() })
const LeaveInput = z.object({})
const RequestRemoveInput = z.object({ person: z.string().trim().min(1).max(200) })
const RequestEndInput = z.object({})
const HandoffInput = z.object({ request: z.string().trim().min(1).max(HANDOFF_REQUEST_MAX) })

/**
 * The room tools, each a factory of the turn's context (as `presenceToolOf` in the front agent). Every call first reports
 * the principal it saw to `deps.onToolCall`, when the recorder is set (the test seam; the report carries no text).
 */
export function createRoomTools(deps: RoomToolDeps): Record<string, (ctx: HarnessContext) => Tool> {
  const now = deps.now ?? Date.now
  const nameOf = async (personId: string): Promise<string | null> =>
    (await deps.people.get(personId).catch(() => undefined))?.name ?? null

  /** Whether the speaker may ask for a removal or an end: the initiator of the room, or the owner of the instance. */
  const mayRequest = async (speaker: Speaker): Promise<boolean> => {
    if (speaker.room.initiator === speaker.personId) return true
    const person = await deps.people.get(speaker.personId).catch(() => undefined)
    return person?.role === 'owner'
  }
  /** The refusal of a request by anyone else: the `room.turn.refused` row, then the error the model sees. */
  const refuseRequest = (speaker: Speaker, tool: string): never => {
    deps.service.turnRefused(speaker.personId, speaker.roomId, tool, NOT_ALLOWED_REASON)
    throw new Error(NOT_ALLOWED)
  }

  const tools: Record<string, (ctx: HarnessContext) => Tool> = {
    [ROOM_SAY_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Post a line in the room as Keith. Use it for an announcement to one person ("to Ana: ..."); your final answer of a turn is posted the same way.',
        inputSchema: SayInput,
        metadata: { risk: 'write' },
        execute: async ({ text }: z.infer<typeof SayInput>) => {
          const speaker = speakerOf(deps, ctx)
          const seq = await deps.transport.sayLine(speaker.roomId, 'keith', text)
          return { seq }
        },
      }),

    [ROOM_PRESENCE_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'The presence of each member of the room, as far as each one shares it with the person who is speaking. A member who shares nothing is "not shared". Never guess a state.',
        inputSchema: z.object({}),
        metadata: { risk: 'read' },
        execute: async () => {
          const speaker = speakerOf(deps, ctx)
          const members = deps.rooms.members(speaker.roomId).filter((m) => m.status === 'active')
          const lines: { person: string; line: string }[] = []
          for (const member of members) {
            const released = await deps.presence.disclosedFor(speaker.personId, member.personId)
            lines.push({ person: member.personId, line: released.line ?? 'not shared' })
          }
          return { members: lines }
        },
      }),

    [ROOM_ACTIVITY_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'The recent lines of the room, oldest first, within the room window. Pass minutes to look back less far than the window.',
        inputSchema: ActivityInput,
        metadata: { risk: 'read' },
        execute: async ({ minutes }: z.infer<typeof ActivityInput>) => {
          const speaker = speakerOf(deps, ctx)
          const at = now()
          const cut =
            minutes === undefined
              ? undefined
              : at - Math.min(minutes, speaker.room.windowMinutes) * 60_000
          const events = deps.rooms
            .window(speaker.roomId, at)
            .filter((e) => cut === undefined || e.at >= cut)
          const out: RoomLine[] = []
          for (const e of events) {
            out.push({
              seq: e.seq,
              at: e.at,
              kind: e.kind,
              speaker: e.speaker,
              speakerName: e.speaker === null ? null : await nameOf(e.speaker),
              text: e.text,
            })
          }
          return { lines: out }
        },
      }),

    [ROOM_LEAVE_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Leave the room now. You can only leave for yourself; you cannot remove anyone with this tool.',
        inputSchema: LeaveInput,
        metadata: { risk: 'write' },
        execute: async () => {
          const speaker = speakerOf(deps, ctx)
          deps.service.leave({ by: speaker.personId, via: 'tcp' }, speaker.roomId)
          return { left: true }
        },
      }),

    [ROOM_REQUEST_REMOVE_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Ask the initiator or the owner to confirm removing a member from the room. You remove nobody: the request waits for that person to confirm it. Only the initiator or the owner may ask.',
        inputSchema: RequestRemoveInput,
        metadata: { risk: 'write' },
        execute: async ({ person }: z.infer<typeof RequestRemoveInput>) => {
          const speaker = speakerOf(deps, ctx)
          if (!(await mayRequest(speaker))) return refuseRequest(speaker, ROOM_REQUEST_REMOVE_TOOL)
          const request = await deps.service.requestRemove(
            { by: speaker.personId, via: 'local' },
            speaker.roomId,
            person,
          )
          return { requested: true, requestId: request.id }
        },
      }),

    [ROOM_REQUEST_END_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Ask the initiator or the owner to confirm ending the room for everyone. You end nothing: the request waits for that person to confirm it. Only the initiator or the owner may ask.',
        inputSchema: RequestEndInput,
        metadata: { risk: 'write' },
        execute: async () => {
          const speaker = speakerOf(deps, ctx)
          if (!(await mayRequest(speaker))) return refuseRequest(speaker, ROOM_REQUEST_END_TOOL)
          const request = await deps.service.requestEnd(
            { by: speaker.personId, via: 'local' },
            speaker.roomId,
          )
          return { requested: true, requestId: request.id }
        },
      }),

    [ROOM_HANDOFF_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          "Hand the speaker's own personal request to the speaker's own chat with Keith: a note, a memory, a task, a file or anything else that is theirs and not the room's. Pass only what the speaker asked, in their words. It is done in that person's own chat, never here. The result tells you the line to answer in the room.",
        inputSchema: HandoffInput,
        metadata: { risk: 'write' },
        execute: async ({ request }: z.infer<typeof HandoffInput>) => {
          const speaker = speakerOf(deps, ctx)
          const seq = deps.turnSeqs.of(speaker.roomId)
          if (seq === undefined) throw new Error(NO_TURN_REFUSAL)
          const outcome = await deps.handoff.hand({
            roomId: speaker.roomId,
            speakerId: speaker.personId,
            seq,
            request,
          })
          if (outcome.status === 'failed') return { handed: false, reason: outcome.reason }
          return { handed: true, answerInRoom: HANDOFF_REPLY }
        },
      }),
  }

  return Object.fromEntries(
    Object.entries(tools).map(([name, make]) => [name, withRecorder(deps, name, make)]),
  )
}

/** Wraps a tool factory so that every call is reported to `deps.onToolCall` before its own checks run. */
function withRecorder(
  deps: RoomToolDeps,
  name: string,
  make: (ctx: HarnessContext) => Tool,
): (ctx: HarnessContext) => Tool {
  return (ctx) => {
    const made = make(ctx) as Tool & { execute: (input: unknown, options: unknown) => unknown }
    const execute = made.execute
    return {
      ...made,
      execute: (input: unknown, options: unknown) => {
        deps.onToolCall?.({
          tool: name,
          principalId: ctx.principal?.id,
          roomId: roomIdOfSession(ctx.session.id),
        })
        return execute(input, options)
      },
    } as Tool
  }
}

/** Plugin of the room tools: added to the room agent only (`agent.ts`). */
export function roomTools(deps: RoomToolDeps): HarnessPlugin<'keith-corpus-callosum-tools'> {
  return definePlugin({
    name: 'keith-corpus-callosum-tools',
    setup: () => ({ tools: createRoomTools(deps) }),
  })
}
