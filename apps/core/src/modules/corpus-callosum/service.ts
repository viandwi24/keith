// The room service: the lifecycle of a shared room without any model (docs/specs/corpus-callosum.md "Control and limits",
// "Audit", "Transport"; ADR-0026 §1 and §5, ADR-0020 §4). Start, invite, accept, decline, leave, remove, end, the expiry sweep,
// and the end of one person's memberships (suspension, removal of the person). Every write checks the membership of the
// caller: the initiator is the ACL owner of the room, so the ACL alone never decides a write. Rights of the owner come from the
// owner role; the initiator's rights need an active membership.
import {
  type AuditVia,
  type EventData,
  type MemberRecord,
  REQUEST_TTL_MS,
  type RequestKind,
  type RequestRecord,
  type RoomRecord,
  type RoomsRepo,
} from '@keith/db'
import { uuidv7 } from 'eharness'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import { PeopleError } from '../people/index.ts'
import type { RoomAcl } from './acl.ts'
import type { Audit, RoomDelivery, RoomPeople } from './ports.ts'
import type { RoomSettingsReader } from './settings.ts'
import type { TextRoomTransport } from './transport-text.ts'
import { createRoomWorkspace, sealRoomWorkspace } from './workspace.ts'

export type RoomErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'TOO_MANY_REQUESTS'
export type RoomRefusal = 'not-member' | 'not-initiator' | 'no-capability'

/** A refusal of the room service. `code` is the RPC code; `reason` names the FORBIDDEN case. */
export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
    readonly reason?: RoomRefusal,
  ) {
    super(message)
    this.name = 'RoomError'
  }
}

/** Who asks and through which listener: the audit actor and via. The system acts as `system` on `local`. */
export interface RoomCaller {
  by: string
  via: AuditVia
}
export const SYSTEM_CALLER: RoomCaller = { by: 'system', via: 'local' }

/**
 * The per-recipient feed port of the room (ADR-0026 §6). The text and indicator transport implements it (P30.2.2): after an
 * event is written, `notify` is called with the people who must learn of it and the event's `seq`. Fire and forget.
 */
export interface RoomFeed {
  notify(roomId: string, personIds: readonly string[], seq: number): void
}

/** Writes an activity record on a session (the core's `emit`, bound to its store). Never throws. */
export interface RoomActivity {
  record(sessionId: string, type: string, payload: Record<string, unknown>): void
}

/** Whether a person holds a capability (the role table plus the grants). */
export interface RoomCapabilities {
  holds(personId: string, capability: string): boolean | Promise<boolean>
}

export const ROOM_START_CAPABILITY = 'rooms.start'
const MINUTE_MS = 60_000
/** The room name default: `Room of <initiator>`, cut to the name limit. */
const ROOM_NAME_MAX = 60
/** The longest text a `post` request carries (the transcript limit). */
const ROOM_POST_MAX = 2000

/** The session a room's turns run in (one per generation; no `front:` prefix, so no person owns it). */
export const roomSessionId = (roomId: string, generation: number): string =>
  `room:${roomId}:g${generation}`

export interface RoomServiceOptions {
  rooms: RoomsRepo
  acl: RoomAcl
  people: RoomPeople
  delivery: RoomDelivery
  audit: Pick<Audit, 'record'>
  feed: RoomFeed
  /** The line writer of the text transport (`rooms.say`): writes the line, fans it out, returns its seq. */
  transport: Pick<TextRoomTransport, 'sayLine' | 'postLine'>
  activity?: RoomActivity
  capabilities: RoomCapabilities
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
  settings: RoomSettingsReader
  dataDir: string
  now: () => number
  newId?: () => string
  warn?: (message: string) => void
}

export interface InviteOutcome {
  person: string
  /** `invited`: the invitation was written and sent; `exists`: already invited or active; `refused`: removed, or the room ended. */
  status: 'invited' | 'exists' | 'refused'
}

export interface RoomStarted {
  room: RoomRecord
  invites: InviteOutcome[]
}

/** One membership a person's removal or suspension ended: the row before, and the `remove` row written (none for an invitation). */
export interface EndedMembership {
  roomId: string
  from: MemberRecord
  /** The `remove` row written for an active membership (none for an invitation). */
  seq: number | undefined
  /** The `end` row, when the removal left the room with no active member and the room ended (`empty`). */
  endSeq: number | undefined
}

export interface SweepResult {
  invites: number
  requests: number
}

/** The answer of `confirm`: `confirmed` when the requested change was carried out, `refused` when the person said no. */
export interface ConfirmOutcome {
  status: 'confirmed' | 'refused'
}

/**
 * What a confirmed request does, by its kind (the extension point of the confirmations: `post` joins in P30.4.3).
 * `check` runs before the request is settled, so a confirmation that cannot be carried out leaves it pending; `apply`
 * runs after it is settled, so a request is never applied twice.
 */
interface ConfirmHandler {
  check(caller: RoomCaller, room: RoomRecord, request: RequestRecord): Promise<void>
  apply(caller: RoomCaller, room: RoomRecord, request: RequestRecord): Promise<void>
}

export interface RoomService {
  start(
    caller: RoomCaller,
    input: { name?: string; invite: readonly string[] },
  ): Promise<RoomStarted>
  invite(caller: RoomCaller, roomId: string, invite: readonly string[]): Promise<InviteOutcome[]>
  accept(caller: RoomCaller, roomId: string): RoomRecord
  decline(caller: RoomCaller, roomId: string): void
  /**
   * An active member's line: stored and fanned out. Returns its seq. `data` carries the turn markers the turn pipeline
   * decides before the write (`queued`, `refused`); the service only stores them (`turns.ts`).
   */
  say(caller: RoomCaller, roomId: string, text: string, data?: EventData): Promise<number>
  leave(caller: RoomCaller, roomId: string): void
  remove(caller: RoomCaller, roomId: string, person: string): Promise<void>
  end(caller: RoomCaller, roomId: string, reason?: string): Promise<void>
  /** Ends every membership of a person: an active one becomes `removed` with a `remove` row; an invitation is declined. */
  endMemberships(
    personId: string,
    reason: 'removed' | 'suspended',
    caller: RoomCaller,
  ): EndedMembership[]
  /**
   * A speaker's request to remove a member (`room_request_remove`): only the initiator or the owner may ask. It writes one
   * `room_requests` row whose confirmer is the caller; it removes nobody. `person` is a username or an id.
   */
  requestRemove(caller: RoomCaller, roomId: string, person: string): Promise<RequestRecord>
  /** A speaker's request to end the room (`room_request_end`): the same rule and the same row as `requestRemove`. */
  requestEnd(caller: RoomCaller, roomId: string): Promise<RequestRecord>
  /**
   * A person's own text to share with the room (`room_post`): one `post` request that names the person as its confirmer.
   * Nothing is posted here. Only an active member may ask; the text is stored exactly as given.
   */
  requestPost(caller: RoomCaller, roomId: string, text: string): RequestRecord
  /** A room tool refused a call of a turn: one `room.turn.refused` row (speaker, tool, reason; no text). */
  turnRefused(speaker: string, roomId: string, tool: string, reason: string): void
  /**
   * The person a request names confirms it (or the owner, for a remove or an end). Approved: the change is carried out; refused:
   * nothing changes. Another caller is `FORBIDDEN`; an expired request is `PRECONDITION_FAILED` and changes nothing.
   */
  confirm(requestId: string, caller: RoomCaller, approved: boolean): Promise<ConfirmOutcome>
  /** Expires invitations older than `rooms.inviteTtlMinutes` and pending confirmations past their expiry. */
  sweep(): SweepResult
}

export function createRoomService(options: RoomServiceOptions): RoomService {
  const { rooms, acl, people, delivery, audit, feed, capabilities, settings, dataDir } = options
  const transport = options.transport
  const now = options.now
  const newId = options.newId ?? (() => uuidv7())
  const warn = options.warn ?? (() => {})

  const requireRoom = (roomId: string): RoomRecord => {
    const room = rooms.get(roomId)
    if (room === undefined) throw new RoomError('NOT_FOUND', 'no such room')
    return room
  }

  /** A room that is still open for writes: an ended one answers PRECONDITION_FAILED before any right is checked. */
  const requireOpen = (roomId: string): RoomRecord => {
    const room = requireRoom(roomId)
    if (room.state === 'ended') throw new RoomError('PRECONDITION_FAILED', 'the room has ended')
    return room
  }

  const personOrUndefined = async (ref: string) => {
    try {
      return await people.get(ref)
    } catch (error) {
      if (error instanceof PeopleError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }

  const nameOf = async (personId: string): Promise<string> =>
    (await personOrUndefined(personId))?.name ?? personId

  const isOwner = async (personId: string): Promise<boolean> =>
    (await personOrUndefined(personId))?.role === 'owner'

  const activeIds = (roomId: string): string[] =>
    rooms
      .members(roomId)
      .filter((m) => m.status === 'active')
      .map((m) => m.personId)

  /** The people who must learn of an event: sent once, with the event's seq. */
  const announce = (roomId: string, personIds: readonly string[], seq: number): void => {
    const ids = [...new Set(personIds)]
    if (ids.length === 0) return
    try {
      feed.notify(roomId, ids, seq)
    } catch (error) {
      warn(`rooms: feed notify failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const brain = (sessionId: string, type: string, payload: Record<string, unknown>): void => {
    options.activity?.record(sessionId, type, { region: 'corpus-callosum', ...payload })
  }

  /**
   * The control rule (ADR-0026 §5): the owner role may control any room; the initiator may control the room while they are an
   * active member. Anyone else is refused: `not-initiator` when they are an active member without the right, `not-member` otherwise.
   */
  const control = async (caller: RoomCaller, room: RoomRecord): Promise<void> => {
    if (await isOwner(caller.by)) return
    const member = rooms.member(room.id, caller.by)
    const active = member?.status === 'active'
    if (!active) throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
    if (room.initiator !== caller.by)
      throw new RoomError('FORBIDDEN', 'only the initiator or the owner', 'not-initiator')
  }

  /** The people an invitation names: active persons, deduplicated. A missing person is `NOT_FOUND`, a suspended one refused. */
  const resolveInvitees = async (
    refs: readonly string[],
  ): Promise<{ id: string; name: string }[]> => {
    const out: { id: string; name: string }[] = []
    for (const ref of refs) {
      const person = await personOrUndefined(ref)
      if (person === undefined) throw new RoomError('NOT_FOUND', `no person ${ref}`)
      if (person.status !== 'active')
        throw new RoomError('PRECONDITION_FAILED', `${person.name} is not an active person`)
      if (!out.some((p) => p.id === person.id)) out.push({ id: person.id, name: person.name })
    }
    return out
  }

  const inviteTtlMs = (): number => settings.inviteTtlMinutes() * MINUTE_MS

  /** Expires the invitations past their lifetime (`invited_at < now - ttl`). Returns how many. */
  const expireInvites = (at: number): number => rooms.expireInvites(at - inviteTtlMs())

  const sendInvite = async (room: RoomRecord, person: string, at: number): Promise<void> => {
    const initiatorName = await nameOf(room.initiator)
    try {
      await delivery.deliver({
        id: `room-invite:${room.id}:${person}:${at}`,
        source: 'corpus-callosum',
        to: person,
        name: 'room.invite',
        text: `${initiatorName} invites you to a room with Keith.`,
        needs: { mode: 'note' },
      })
    } catch (error) {
      warn(`rooms: invitation not sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Writes the invitation row, the audit row and the delivery. The row is the truth; a failed delivery leaves it to expire. */
  const inviteOne = async (
    caller: RoomCaller,
    room: RoomRecord,
    person: string,
    at: number,
  ): Promise<InviteOutcome> => {
    const result = rooms.invite(room.id, person, caller.by, at)
    if (result !== 'invited') return { person, status: result }
    audit.record({
      kind: 'room.invite',
      actor: caller.by,
      via: caller.via,
      detail: { roomId: room.id, subject: person },
    })
    await sendInvite(room, person, at)
    // the invitee's front session carries the event: the TUI reads the invitation again on it (no text)
    brain(
      frontSessionId(person, options.generations.current(person)),
      'brain.corpus-callosum.invite',
      {
        roomId: room.id,
      },
    )
    return { person, status: 'invited' }
  }

  /** Activity of a join: the person's own front session carries the brain event (no text). */
  const joinBrain = (roomId: string, personId: string): void =>
    brain(
      frontSessionId(personId, options.generations.current(personId)),
      'brain.corpus-callosum.join',
      {
        roomId,
      },
    )

  /**
   * The end of a room: its active members lose `w` (they keep `r` up to the end), the `end` row is written, the workspace is
   * sealed, and the audit rows follow. A room that has already ended is left alone. `ownerEnd` marks an end by the owner who
   * did not start the room (`room.owner-end`, in addition to `room.end`). Returns the `seq` of the `end` row, or undefined.
   */
  const endRoom = (
    room: RoomRecord,
    by: string,
    reason: string,
    at: number,
    caller: RoomCaller,
    ownerEnd: boolean,
  ): number | undefined => {
    const members = activeIds(room.id)
    if (rooms.end(room.id, by, reason, at) !== 'ended') return undefined
    for (const person of members) acl.revokeWrite(room.id, person, caller.by)
    const seq = rooms.appendEvent({ roomId: room.id, at, kind: 'end', data: { reason } })
    announce(room.id, members, seq)
    sealRoomWorkspace(dataDir, room.id)
    audit.record({
      kind: 'room.end',
      actor: caller.by,
      via: caller.via,
      detail: { roomId: room.id, subject: room.initiator, reason, endedBy: by },
    })
    if (ownerEnd)
      audit.record({
        kind: 'room.owner-end',
        actor: caller.by,
        via: caller.via,
        detail: { roomId: room.id, subject: room.initiator, reason, members },
      })
    brain(roomSessionId(room.id, room.generation), 'brain.corpus-callosum.end', {
      roomId: room.id,
      reason,
    })
    return seq
  }

  /** A pending confirmation of the room: the row of the request, written with the caller as its confirmer. */
  const openRequest = (
    caller: RoomCaller,
    room: RoomRecord,
    kind: RequestKind,
    payload: EventData,
  ): RequestRecord => {
    const at = now()
    return rooms.createRequest({
      id: newId(),
      roomId: room.id,
      person: caller.by,
      kind,
      payload,
      createdAt: at,
      expiresAt: at + REQUEST_TTL_MS,
    })
  }

  /** The text a `post` request carries (its payload). A request without a valid text is refused, never posted empty. */
  const postText = (request: RequestRecord): string => {
    const text = request.payload?.text
    if (typeof text !== 'string' || text.length === 0 || text.length > ROOM_POST_MAX)
      throw new RoomError('PRECONDITION_FAILED', 'the request names no text to post')
    return text
  }

  /** Settles a pending request: an expired one answers `PRECONDITION_FAILED`, one already settled `CONFLICT`. */
  const settle = (request: RequestRecord, to: 'confirmed' | 'refused'): void => {
    const result = rooms.decideRequest(request.id, to, now())
    if (result === 'expired') throw new RoomError('PRECONDITION_FAILED', 'the request expired')
    if (result === 'stale') throw new RoomError('CONFLICT', 'already answered')
  }

  /**
   * The confirmation handlers by kind. `check` runs before the request is settled, `apply` after. A `post` posts the exact
   * text stored with the request, as the person, once.
   */
  const handlers: Partial<Record<RequestKind, ConfirmHandler>> = {
    remove: {
      async check(caller, room, request) {
        await control(caller, room)
        const target = request.payload?.target
        if (typeof target !== 'string')
          throw new RoomError('PRECONDITION_FAILED', 'the request names no one')
        if (rooms.member(room.id, target)?.status !== 'active')
          throw new RoomError('CONFLICT', 'that person is not in the room')
      },
      async apply(caller, room, request) {
        await service.remove(caller, room.id, String(request.payload?.target))
      },
    },
    end: {
      check: (caller, room) => control(caller, room),
      async apply(caller, room) {
        await service.end(caller, room.id)
      },
    },
    post: {
      async check(caller: RoomCaller, room: RoomRecord, request: RequestRecord) {
        if (request.person !== caller.by)
          throw new RoomError('FORBIDDEN', 'only the person the request names', 'not-initiator')
        if (rooms.member(room.id, caller.by)?.status !== 'active')
          throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
        postText(request)
      },
      async apply(caller: RoomCaller, room: RoomRecord, request: RequestRecord) {
        const seq = await transport.postLine(room.id, caller.by, postText(request))
        audit.record({
          kind: 'room.post',
          actor: caller.by,
          via: caller.via,
          detail: { roomId: room.id, subject: caller.by, seq },
        })
      },
    },
  }

  const service: RoomService = {
    async start(caller, input) {
      if (!(await capabilities.holds(caller.by, ROOM_START_CAPABILITY)))
        throw new RoomError('FORBIDDEN', 'the rooms.start capability is needed', 'no-capability')
      const invitees = await resolveInvitees(input.invite)
      if (invitees.some((p) => p.id === caller.by))
        throw new RoomError('PRECONDITION_FAILED', 'the initiator cannot invite themselves')
      const max = settings.maxMembers()
      if (invitees.length > max)
        throw new RoomError('PRECONDITION_FAILED', `a room takes at most ${max} invitees`)
      const initiator = await nameOf(caller.by)
      const at = now()
      const created = rooms.create(
        {
          id: newId(),
          name: (input.name ?? `Room of ${initiator}`).slice(0, ROOM_NAME_MAX),
          initiator: caller.by,
          answerMode: 'addressed',
          windowMinutes: settings.windowMinutes(),
          windowEvents: settings.windowEvents(),
        },
        at,
      )
      if (created.status === 'busy')
        throw new RoomError('CONFLICT', 'you are already active in another room')
      const room = created.room
      acl.create(room.id, caller.by)
      createRoomWorkspace(dataDir, room.id)
      audit.record({
        kind: 'room.create',
        actor: caller.by,
        via: caller.via,
        detail: { roomId: room.id, subject: caller.by, invitees: invitees.length },
      })
      const invites: InviteOutcome[] = []
      for (const invitee of invitees) invites.push(await inviteOne(caller, room, invitee.id, at))
      return { room, invites }
    },

    async invite(caller, roomId, invite) {
      const room = requireOpen(roomId)
      await control(caller, room)
      const invitees = await resolveInvitees(invite)
      const members = rooms.members(roomId)
      const occupied = new Set(
        members
          .filter((m) => m.status === 'active' || m.status === 'invited')
          .map((m) => m.personId),
      )
      const seats = members.filter(
        (m) => (m.status === 'active' || m.status === 'invited') && m.personId !== room.initiator,
      ).length
      const fresh = invitees.filter((p) => !occupied.has(p.id)).length
      const max = settings.maxMembers()
      if (seats + fresh > max) throw new RoomError('PRECONDITION_FAILED', 'the room is full')
      const at = now()
      expireInvites(at)
      const out: InviteOutcome[] = []
      for (const invitee of invitees) out.push(await inviteOne(caller, room, invitee.id, at))
      return out
    },

    accept(caller, roomId) {
      const room = requireRoom(roomId)
      if (room.state === 'ended') throw new RoomError('PRECONDITION_FAILED', 'the room has ended')
      const at = now()
      expireInvites(at)
      const member = rooms.member(roomId, caller.by)
      if (member === undefined) throw new RoomError('NOT_FOUND', 'no such room')
      if (member.status === 'expired')
        throw new RoomError('PRECONDITION_FAILED', 'the invitation expired')
      if (member.status !== 'invited') throw new RoomError('CONFLICT', 'already answered')
      const moved = rooms.accept(roomId, caller.by, at)
      if (moved === 'busy')
        throw new RoomError('CONFLICT', 'you are already active in another room')
      if (moved !== 'moved') throw new RoomError('CONFLICT', 'already answered')
      acl.grant(roomId, caller.by, caller.by)
      audit.record({
        kind: 'room.accept',
        actor: caller.by,
        via: caller.via,
        detail: { roomId, subject: caller.by },
      })
      const seq = rooms.appendEvent({ roomId, at, kind: 'join', speaker: caller.by })
      announce(roomId, activeIds(roomId), seq)
      joinBrain(roomId, caller.by)
      return requireRoom(roomId)
    },

    decline(caller, roomId) {
      const room = requireRoom(roomId)
      if (room.state === 'ended') throw new RoomError('PRECONDITION_FAILED', 'the room has ended')
      const at = now()
      expireInvites(at)
      const member = rooms.member(roomId, caller.by)
      if (member === undefined) throw new RoomError('NOT_FOUND', 'no such room')
      if (member.status === 'expired')
        throw new RoomError('PRECONDITION_FAILED', 'the invitation expired')
      if (rooms.decline(roomId, caller.by) !== 'moved')
        throw new RoomError('CONFLICT', 'already answered')
      audit.record({
        kind: 'room.decline',
        actor: caller.by,
        via: caller.via,
        detail: { roomId, subject: caller.by },
      })
      // no text and no name: a system line that an invitation was declined, for the members
      const seq = rooms.appendEvent({ roomId, at, kind: 'system', data: { event: 'declined' } })
      announce(roomId, activeIds(roomId), seq)
    },

    async say(caller, roomId, text, data) {
      const room = requireOpen(roomId)
      const member = rooms.member(room.id, caller.by)
      if (member === undefined || member.status !== 'active')
        throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
      return transport.sayLine(room.id, caller.by, text, data)
    },

    leave(caller, roomId) {
      const room = requireRoom(roomId)
      const member = rooms.member(roomId, caller.by)
      if (member === undefined || member.status !== 'active')
        throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
      const at = now()
      const before = activeIds(roomId)
      if (rooms.leave(roomId, caller.by, 'left', 'left', at) !== 'moved')
        throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
      acl.revokeWrite(roomId, caller.by, caller.by)
      const seq = rooms.appendEvent({ roomId, at, kind: 'leave', speaker: caller.by })
      const remaining = activeIds(roomId)
      audit.record({
        kind: 'room.leave',
        actor: caller.by,
        via: caller.via,
        detail: {
          roomId,
          subject: caller.by,
          reason: remaining.length === 0 ? 'empty' : 'left',
        },
      })
      announce(roomId, before, seq)
      if (remaining.length === 0) endRoom(room, caller.by, 'empty', at, caller, false)
    },

    async remove(caller, roomId, ref) {
      const room = requireOpen(roomId)
      await control(caller, room)
      const target = await personOrUndefined(ref)
      if (target === undefined) throw new RoomError('NOT_FOUND', `no person ${ref}`)
      if (target.id === caller.by)
        throw new RoomError('PRECONDITION_FAILED', 'use leave to leave the room')
      const member = rooms.member(roomId, target.id)
      if (member === undefined || member.status !== 'active')
        throw new RoomError('CONFLICT', `${target.name} is not in the room`)
      const at = now()
      const before = activeIds(roomId)
      if (rooms.leave(roomId, target.id, 'removed', 'removed', at) !== 'moved')
        throw new RoomError('CONFLICT', `${target.name} is not in the room`)
      acl.revokeWrite(roomId, target.id, caller.by)
      const seq = rooms.appendEvent({ roomId, at, kind: 'remove', speaker: target.id })
      audit.record({
        kind: 'room.remove',
        actor: caller.by,
        via: caller.via,
        detail: { roomId, subject: target.id, reason: 'removed' },
      })
      announce(roomId, before, seq)
      if (activeIds(roomId).length === 0) endRoom(room, caller.by, 'empty', at, caller, false)
    },

    async end(caller, roomId, reason) {
      const room = requireOpen(roomId)
      await control(caller, room)
      const ownerEnd = room.initiator !== caller.by && (await isOwner(caller.by))
      endRoom(room, caller.by, reason ?? 'ended', now(), caller, ownerEnd)
    },

    endMemberships(personId, reason, caller) {
      const at = now()
      const out: EndedMembership[] = []
      for (const { room, member } of rooms.roomsOf(personId, 1000)) {
        if (member.status === 'invited') {
          rooms.decline(room.id, personId)
          out.push({ roomId: room.id, from: member, seq: undefined, endSeq: undefined })
          continue
        }
        if (member.status !== 'active' || room.state === 'ended') continue
        const before = activeIds(room.id)
        if (rooms.leave(room.id, personId, 'removed', reason, at) !== 'moved') continue
        acl.revokeWrite(room.id, personId, caller.by)
        const seq = rooms.appendEvent({ roomId: room.id, at, kind: 'remove', speaker: personId })
        audit.record({
          kind: 'room.remove',
          actor: caller.by,
          via: caller.via,
          detail: { roomId: room.id, subject: personId, reason },
        })
        announce(room.id, before, seq)
        const endSeq =
          activeIds(room.id).length === 0
            ? endRoom(room, caller.by, 'empty', at, caller, false)
            : undefined
        out.push({ roomId: room.id, from: member, seq, endSeq })
      }
      return out
    },

    async requestRemove(caller, roomId, ref) {
      const room = requireOpen(roomId)
      await control(caller, room)
      const target = await personOrUndefined(ref)
      if (target === undefined) throw new RoomError('NOT_FOUND', `no person ${ref}`)
      if (target.id === caller.by)
        throw new RoomError('PRECONDITION_FAILED', 'use leave to leave the room')
      if (rooms.member(roomId, target.id)?.status !== 'active')
        throw new RoomError('CONFLICT', `${target.name} is not in the room`)
      return openRequest(caller, room, 'remove', { target: target.id })
    },

    async requestEnd(caller, roomId) {
      const room = requireOpen(roomId)
      await control(caller, room)
      return openRequest(caller, room, 'end', {})
    },

    requestPost(caller, roomId, text) {
      const room = requireOpen(roomId)
      if (rooms.member(roomId, caller.by)?.status !== 'active')
        throw new RoomError('FORBIDDEN', 'not a member of this room', 'not-member')
      if (text.length === 0 || text.length > ROOM_POST_MAX)
        throw new RoomError('PRECONDITION_FAILED', `a post takes 1 to ${ROOM_POST_MAX} characters`)
      return openRequest(caller, room, 'post', { text })
    },

    turnRefused(speaker, roomId, tool, reason) {
      audit.record({
        kind: 'room.turn.refused',
        actor: speaker,
        via: 'local',
        detail: { roomId, speaker, tool, reason },
      })
    },

    async confirm(requestId, caller, approved) {
      const request = rooms.request(requestId)
      if (request === undefined) throw new RoomError('NOT_FOUND', 'no such request')
      // the person the request names confirms it; the owner may confirm a remove or an end for any room, never a post
      // (a post is the person's own text, ADR-0020 §2)
      const named = request.person === caller.by
      const ownerMay = request.kind !== 'post' && (await isOwner(caller.by))
      if (!named && !ownerMay) {
        const active = rooms.member(request.roomId, caller.by)?.status === 'active'
        throw new RoomError(
          'FORBIDDEN',
          'only the person the request names, or the owner, may confirm it',
          active ? 'not-initiator' : 'not-member',
        )
      }
      const at = now()
      if (
        request.status === 'expired' ||
        (request.status === 'pending' && request.expiresAt <= at)
      ) {
        if (request.status === 'pending') rooms.decideRequest(request.id, 'refused', at)
        throw new RoomError('PRECONDITION_FAILED', 'the request expired')
      }
      if (request.status !== 'pending') throw new RoomError('CONFLICT', 'already answered')
      const room = requireRoom(request.roomId)
      if (room.state === 'ended') throw new RoomError('PRECONDITION_FAILED', 'the room has ended')
      if (!approved) {
        settle(request, 'refused')
        return { status: 'refused' }
      }
      const handler = handlers[request.kind]
      if (handler === undefined)
        throw new RoomError(
          'PRECONDITION_FAILED',
          `a ${request.kind} confirmation is not wired yet`,
        )
      await handler.check(caller, room, request)
      settle(request, 'confirmed')
      await handler.apply(caller, room, request)
      return { status: 'confirmed' }
    },

    sweep() {
      const at = now()
      return { invites: expireInvites(at), requests: rooms.expireRequests(at) }
    },
  }
  return service
}
