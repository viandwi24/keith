// The room procedures (`rooms.*`, docs/specs/corpus-callosum.md "RPC"). The handlers read the caller from the context, call the
// room service (which checks the membership and the control rule) and the ACL for transcript reads, then answer the shapes of
// packages/contracts/src/rooms.ts. A room the caller may not see (no membership row and not the owner) is `NOT_FOUND` for every
// procedure that names it; a refusal of the service leaves as the RPC error of its code with `data.reason` for FORBIDDEN.
import {
  type AclActor,
  ROOM_PRESENCE_NOT_SHARED,
  type RoomEvent,
  type RoomPerson,
  type RoomRequest,
} from '@keith/contracts'
import type { EventRecord, MemberRecord, RequestRecord, RoomRecord, RoomsRepo } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import type { RoomAcl } from './acl.ts'
import type { RoomPeople, RoomPresence } from './ports.ts'
import { type RoomCaller, RoomError, type RoomService } from './service.ts'
import type { RoomSettingsReader } from './settings.ts'
import type { TextRoomTransport } from './transport-text.ts'
import type { RoomTurns } from './turns.ts'
import { listRoomFiles } from './workspace.ts'

/** The rooms the procedures read: the repo's rows, the ACL's transcript read, the service's writes. */
export interface RoomProcedureDeps {
  service: RoomService
  /** The turn pipeline: `rooms.say` stores the line, decides whether it addresses Keith and queues the turn (`turns.ts`). */
  turns: Pick<RoomTurns, 'say'>
  rooms: Pick<RoomsRepo, 'get' | 'list' | 'roomsOf' | 'members' | 'member' | 'pendingInRoom'>
  acl: Pick<RoomAcl, 'read'>
  people: RoomPeople
  /** The disclosed presence of each member as the caller reads it (P27, `disclosedFor`). */
  presence: RoomPresence
  /** The indicator the text transport holds in memory (`indicatorOf`). */
  indicators: Pick<TextRoomTransport, 'indicatorOf'>
  settings: RoomSettingsReader
  dataDir: string
  now: () => number
}

const EVENTS_DEFAULT_LIMIT = 100
const LIST_DEFAULT_LIMIT = 50
const MINUTE_MS = 60_000
const KEITH: RoomPerson = { id: 'keith', name: 'Keith' }

const callerOf = (context: RpcContext): RoomCaller => ({
  by: context.principal.personId,
  via: context.via,
})

const actorOf = (context: RpcContext): AclActor => ({
  kind: 'user',
  id: context.principal.personId,
  role: context.principal.role,
})

/** A service refusal as the RPC error of its code; `data.reason` names the FORBIDDEN case (null otherwise). */
async function refusing<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof RoomError)
      throw new ORPCError(error.code, {
        message: error.message,
        data: { reason: error.reason ?? null },
      })
    throw error
  }
}

export function roomProcedures(deps: RoomProcedureDeps) {
  const { service, turns, rooms, acl, people, presence, indicators, settings, dataDir } = deps

  /** A person as a room shows them. A person the directory no longer knows keeps their id as the name. */
  const personOf = async (id: string): Promise<RoomPerson> => {
    try {
      const person = await people.get(id)
      return { id: person.id, name: person.name }
    } catch {
      return { id, name: id }
    }
  }

  const roomDto = async (room: RoomRecord) => ({
    id: room.id,
    name: room.name,
    initiator: await personOf(room.initiator),
    state: room.state,
    answerMode: room.answerMode,
    windowMinutes: room.windowMinutes,
    windowEvents: room.windowEvents,
    transport: room.transport,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    endedBy: room.endedBy === null ? null : await personOf(room.endedBy),
    endReason: room.endReason,
  })

  const memberDto = async (member: MemberRecord) => ({
    person: await personOf(member.personId),
    status: member.status,
    invitedBy: member.invitedBy === null ? null : await personOf(member.invitedBy),
    invitedAt: member.invitedAt,
    joinedAt: member.joinedAt,
    leftAt: member.leftAt,
    leaveReason: member.leaveReason,
  })

  const headerOf = async (room: RoomRecord) => ({
    room: await roomDto(room),
    members: await Promise.all(rooms.members(room.id).map(memberDto)),
  })

  const requestDto = async (request: RequestRecord): Promise<RoomRequest> => {
    const payload = request.payload ?? {}
    const target = typeof payload.target === 'string' ? await personOf(payload.target) : undefined
    const text = typeof payload.text === 'string' ? payload.text : undefined
    return {
      id: request.id,
      roomId: request.roomId,
      kind: request.kind,
      status: request.status,
      person: request.person,
      payload: {
        ...(target === undefined ? {} : { target }),
        ...(text === undefined ? {} : { text }),
      },
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    }
  }

  /** The disclosed presence line of a member as the viewer reads it (P27), or `not shared` when none is released. */
  const presenceOf = async (viewer: string, subject: string): Promise<string> =>
    (await presence.disclosedFor(viewer, subject)).line ?? ROOM_PRESENCE_NOT_SHARED

  /**
   * The room as the caller sees it now: the header, the members, the caller's own standing and what they may do, the indicator
   * and the requests the caller may confirm. Presence and the indicator are for the active members only (corpus-callosum.md
   * "RPC"): anyone else reads `not shared` and `idle`, the owner included when not a member.
   */
  const viewOf = async (caller: RoomCaller, room: RoomRecord) => {
    const members = rooms.members(room.id)
    const mine = members.find((m) => m.personId === caller.by)
    const owner = await isOwner(caller.by)
    const open = room.state !== 'ended'
    const active = mine?.status === 'active'
    const isInitiator = room.initiator === caller.by
    // a `post` is the person's own text: only its person confirms it; a remove or an end is the owner's too
    const confirmable = rooms
      .pendingInRoom(room.id, deps.now())
      .filter((r) => r.person === caller.by || (owner && r.kind !== 'post'))
    return {
      room: await roomDto(room),
      members: await Promise.all(
        members.map(async (m) => ({
          ...(await memberDto(m)),
          presence:
            active && m.status === 'active'
              ? await presenceOf(caller.by, m.personId)
              : ROOM_PRESENCE_NOT_SHARED,
        })),
      ),
      indicator: active ? indicators.indicatorOf(room.id) : { kind: 'idle' as const },
      you: {
        status: mine?.status ?? null,
        isInitiator,
        canSpeak: open && active,
        canControl: open && (owner || (isInitiator && active)),
      },
      pending: await Promise.all(confirmable.map(requestDto)),
    }
  }

  const isOwner = async (personId: string): Promise<boolean> => {
    try {
      return (await people.get(personId)).role === 'owner'
    } catch {
      return false
    }
  }

  /**
   * The room, when the caller may see it: the owner sees every room; anyone else only the rooms where they have a membership
   * row (an invitation, an active or a past membership). Anything else is `NOT_FOUND`, as good as absent.
   */
  const visibleRoom = (context: RpcContext, roomId: string): RoomRecord => {
    const room = rooms.get(roomId)
    if (room === undefined) throw new ORPCError('NOT_FOUND', { message: 'there is no such room' })
    if (context.principal.role === 'owner') return room
    if (rooms.member(roomId, context.principal.personId) === undefined)
      throw new ORPCError('NOT_FOUND', { message: 'there is no such room' })
    return room
  }

  return {
    start: rpc.rooms.start.handler(async ({ input, context }) => {
      const started = await refusing(() =>
        service.start(callerOf(context), {
          invite: input.invite,
          ...(input.name === undefined ? {} : { name: input.name }),
        }),
      )
      return viewOf(callerOf(context), started.room)
    }),

    invite: rpc.rooms.invite.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.invite(callerOf(context), input.roomId, input.invite))
      return viewOf(callerOf(context), requireRoom(input.roomId))
    }),

    accept: rpc.rooms.accept.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.accept(callerOf(context), input.roomId))
      return viewOf(callerOf(context), requireRoom(input.roomId))
    }),

    decline: rpc.rooms.decline.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.decline(callerOf(context), input.roomId))
      return { ok: true as const }
    }),

    say: rpc.rooms.say.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      return refusing(() =>
        turns.say(callerOf(context), input.roomId, input.text, input.replyToKeith),
      )
    }),

    leave: rpc.rooms.leave.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.leave(callerOf(context), input.roomId))
      return { ok: true as const }
    }),

    remove: rpc.rooms.remove.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.remove(callerOf(context), input.roomId, input.person))
      return { ok: true as const }
    }),

    end: rpc.rooms.end.handler(async ({ input, context }) => {
      visibleRoom(context, input.roomId)
      await refusing(() => service.end(callerOf(context), input.roomId, input.reason))
      return { ok: true as const }
    }),

    /** The person a request names confirms it (or the owner, for a remove or an end): the service decides (`confirm`). */
    confirm: rpc.rooms.confirm.handler(({ input, context }) =>
      refusing(() => service.confirm(input.requestId, callerOf(context), input.approved)),
    ),

    get: rpc.rooms.get.handler(async ({ input, context }) =>
      viewOf(callerOf(context), visibleRoom(context, input.roomId)),
    ),

    list: rpc.rooms.list.handler(async ({ input, context }) => {
      const limit = input.limit ?? LIST_DEFAULT_LIMIT
      const caller = context.principal.personId
      const owner = context.principal.role === 'owner'
      const picked = owner
        ? rooms.list(limit).map((room) => ({ room, mine: rooms.member(room.id, caller) }))
        : rooms.roomsOf(caller, limit).map((row) => ({ room: row.room, mine: row.member }))
      // the caller's invitation lives `rooms.inviteTtlMinutes` from its `invited_at` (the service expires it the same way)
      const ttlMs = settings.inviteTtlMinutes() * MINUTE_MS
      return {
        rooms: await Promise.all(
          picked.map(async ({ room, mine }) => ({
            ...(await headerOf(room)),
            inviteExpiresAt: mine?.status === 'invited' ? mine.invitedAt + ttlMs : null,
          })),
        ),
      }
    }),

    events: rpc.rooms.events.handler(async ({ input, context }) => {
      const room = visibleRoom(context, input.roomId)
      const after = input.after ?? 0
      const limit = input.limit ?? EVENTS_DEFAULT_LIMIT
      // the ACL decides the read: a member up to `left_at`, the owner through the audited owner path
      const rows: EventRecord[] | undefined = acl.read(
        { actor: actorOf(context), caller: { by: context.principal.personId, via: context.via } },
        room.id,
        after,
        limit,
      )
      if (rows === undefined) throw new ORPCError('NOT_FOUND', { message: 'there is no such room' })
      const events: RoomEvent[] = await Promise.all(rows.map(eventOf))
      return { events, nextAfter: rows.at(-1)?.seq ?? after }
    }),

    files: rpc.rooms.files.handler(({ input, context }) => {
      const room = visibleRoom(context, input.roomId)
      // the folder is for the members who may speak: an active membership, not an invitation and not a past one
      const mine = rooms.member(room.id, context.principal.personId)
      if (mine?.status !== 'active')
        throw new ORPCError('NOT_FOUND', { message: 'there is no such room' })
      const files = listRoomFiles(dataDir, room.id, input.path ?? '')
      if (files === undefined)
        throw new ORPCError('NOT_FOUND', { message: 'there is no such path' })
      return { files }
    }),

    settings: {
      get: rpc.rooms.settings.get.handler(() => settings.values()),
      set: rpc.rooms.settings.set.handler(({ input, context }) => {
        let change: ReturnType<RoomSettingsReader['set']>
        try {
          change = settings.set(input)
        } catch (error) {
          if (error instanceof RangeError)
            throw new ORPCError('BAD_REQUEST', { message: error.message })
          throw error
        }
        context.record('settings.rooms.set', change)
        return settings.values()
      }),
    },
  }

  function requireRoom(roomId: string): RoomRecord {
    const room = rooms.get(roomId)
    if (room === undefined) throw new ORPCError('NOT_FOUND', { message: 'there is no such room' })
    return room
  }

  async function eventOf(event: EventRecord): Promise<RoomEvent> {
    const speaker =
      event.speaker === null
        ? null
        : event.speaker === 'keith'
          ? KEITH
          : await personOf(event.speaker)
    // a handoff never carries its text (corpus-callosum.md "Private requests"); the stored text is never sent for it
    return {
      seq: event.seq,
      at: event.at,
      kind: event.kind,
      speaker,
      text: event.kind === 'handoff' ? null : event.text,
    }
  }
}
