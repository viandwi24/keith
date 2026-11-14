// The shared-room tables (docs/specs/corpus-callosum.md, "Data model", ADR-0026, P30.1.4): rooms, their members, the
// transcript and the confirmations. Every write is one `BEGIN IMMEDIATE` and moves a row only from the state the caller
// read, so two writers cannot both apply the same move. A person is active in one room at a time (a partial unique index
// and a check here). A member reads from their `joined_at` (latest join) up to their `left_at` (`eventsForMember`).
import { immediate, type Sqlite } from '../eh/sql.ts'
import {
  EVENT_COLUMNS,
  type EventRow,
  MEMBER_COLUMNS,
  type MemberRow,
  REQUEST_COLUMNS,
  type RequestRow,
  ROOM_COLUMNS,
  type RoomRow,
  toEvent,
  toMember,
  toRequest,
  toRoom,
} from './rooms-rows.ts'

export const ROOM_STATES = ['open', 'active', 'ended'] as const
export type RoomState = (typeof ROOM_STATES)[number]
export const ANSWER_MODES = ['addressed', 'every'] as const
export type AnswerMode = (typeof ANSWER_MODES)[number]
export const MEMBER_STATUSES = [
  'invited',
  'active',
  'declined',
  'left',
  'removed',
  'expired',
] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]
export const EVENT_KINDS = [
  'say',
  'keith',
  'join',
  'leave',
  'remove',
  'end',
  'system',
  'handoff',
  'post',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export const REQUEST_KINDS = ['remove', 'end', 'post'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]
export const REQUEST_STATUSES = ['pending', 'confirmed', 'refused', 'expired'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** Most characters of one event's text (ADR-0026 §3, the transcript holds room text only). */
export const ROOM_TEXT_MAX = 2000
/** Event kinds that end a membership; a member sees the one written at their `left_at`, nothing else at that instant. */
const MEMBERSHIP_EVENTS = ['leave', 'remove', 'end'] as const

/** Flat JSON of an event (ids, counts, reasons; never a second copy of the text). */
export type EventData = Record<string, string | number | boolean | null>

export interface RoomRecord {
  id: string
  name: string
  initiator: string
  state: RoomState
  answerMode: AnswerMode
  windowMinutes: number
  windowEvents: number
  transport: 'text'
  /** Moved only by a session rollover (`bumpGeneration`). */
  generation: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  endedBy: string | null
  endReason: string | null
}

export interface MemberRecord {
  roomId: string
  personId: string
  status: MemberStatus
  invitedBy: string | null
  invitedAt: number
  joinedAt: number | null
  /** The last moment this member may read the transcript (their leave, removal or the room's end). */
  leftAt: number | null
  leaveReason: string | null
}

export interface EventRecord {
  seq: number
  roomId: string
  at: number
  kind: EventKind
  /** A person id, `keith`, or null. */
  speaker: string | null
  text: string | null
  data: EventData | null
}

export interface RequestRecord {
  id: string
  roomId: string
  /** The person who must confirm. */
  person: string
  kind: RequestKind
  payload: EventData | null
  status: RequestStatus
  createdAt: number
  expiresAt: number
}

export interface NewRoom {
  id: string
  name: string
  initiator: string
  answerMode: AnswerMode
  windowMinutes: number
  windowEvents: number
}

/** `busy`: the initiator is already active in another room; nothing is written. */
export type CreateRoomResult = { status: 'created'; room: RoomRecord } | { status: 'busy' }
/** `moved`; `stale`: the member or the room is not in the state the move needs; `busy`: the person is active elsewhere. */
export type MoveResult = 'moved' | 'stale' | 'busy'
/** `invited`; `exists`: already invited or active; `refused`: removed, or the room has ended. */
export type InviteResult = 'invited' | 'exists' | 'refused'
/** `ended`; `stale`: the room had already ended. */
export type EndResult = 'ended' | 'stale'
/** `decided`; `stale`: not pending; `expired`: pending but past `expires_at` (it is marked expired and nothing is applied). */
export type DecideResult = 'decided' | 'stale' | 'expired'

export interface NewEvent {
  roomId: string
  at: number
  kind: EventKind
  speaker?: string | null
  text?: string | null
  data?: EventData | null
}

export interface NewRequest {
  id: string
  roomId: string
  person: string
  kind: RequestKind
  payload?: EventData | null
  createdAt: number
  expiresAt: number
}

export interface RoomsRepo {
  /** Creates an `open` room with its initiator as the one `active` member. `busy` when the initiator is active elsewhere. */
  create(input: NewRoom, at: number): CreateRoomResult
  get(id: string): RoomRecord | undefined
  /** Rooms, newest first (the owner's header list: no text, no members). */
  list(limit: number): RoomRecord[]
  /** The room where the person is `active` now, or undefined. */
  activeRoomOf(personId: string): RoomRecord | undefined
  /** The person's member rows, newest invitation first, with their room. */
  roomsOf(personId: string, limit: number): { room: RoomRecord; member: MemberRecord }[]
  members(roomId: string): MemberRecord[]
  member(roomId: string, personId: string): MemberRecord | undefined
  /** Invites a person: a new row, or a row that declined, expired or left is invited again. */
  invite(roomId: string, personId: string, invitedBy: string, at: number): InviteResult
  /** `invited` to `active` (the first acceptance moves an `open` room to `active`); `busy` while active elsewhere. */
  accept(roomId: string, personId: string, at: number): MoveResult
  /** `invited` to `declined`. */
  decline(roomId: string, personId: string): MoveResult
  /** Invitations sent before `before` become `expired`; returns how many. */
  expireInvites(before: number): number
  /** `active` to `left` (the speaker's own leave) or `removed`; sets `left_at` to `at`. */
  leave(
    roomId: string,
    personId: string,
    status: 'left' | 'removed',
    reason: string,
    at: number,
  ): MoveResult
  /**
   * Ends a room: its `active` members become `left` (`leave_reason` `ended`) at `at`, its open invitations `expired`, its
   * pending requests `expired`. One transaction; `stale` when the room had already ended.
   */
  end(roomId: string, endedBy: string, reason: string, at: number): EndResult
  /** Adds one to the generation (a new session starts with the next window) and returns it, or undefined for no room. */
  bumpGeneration(roomId: string): number | undefined
  /** Appends an event and returns its `seq`. Throws a RangeError when `text` is over 2000 characters (a caller bug). */
  appendEvent(input: NewEvent): number
  /**
   * The room's window: events of the last `window_minutes` (the room's own setting) and at most `window_events` of the
   * newest, oldest first. Room-wide, not per member.
   */
  window(roomId: string, now: number): EventRecord[]
  /**
   * The transcript a member may read: events after `after` (a seq), oldest first, at most `limit`. Only for a member who
   * joined and is `active`, `left` or `removed`. Lower bound: the member's latest `joined_at` (so a rejoin never shows the
   * gap, and a first join never shows what came before it). Upper bound: before `left_at`, plus the membership event written
   * at that instant. Any other person gets an empty list.
   */
  eventsForMember(roomId: string, personId: string, after: number, limit: number): EventRecord[]
  /** The whole transcript for the owner's audited read: events after `after`, oldest first (no membership check here). */
  eventsForOwner(roomId: string, after: number, limit: number): EventRecord[]
  createRequest(input: NewRequest): RequestRecord
  request(id: string): RequestRecord | undefined
  /** The person's pending requests that have not expired at `now`, oldest first. */
  pendingRequests(person: string, now: number): RequestRecord[]
  /** The room's pending requests that have not expired at `now`, oldest first, whoever confirms them. */
  pendingInRoom(roomId: string, now: number): RequestRecord[]
  /** Settles a pending request to `confirmed` or `refused`; a pending request past its expiry becomes `expired` instead. */
  decideRequest(id: string, to: 'confirmed' | 'refused', at: number): DecideResult
  /** Pending requests whose `expires_at` is at or before `now` become `expired`; returns how many. */
  expireRequests(now: number): number
}

/** The request lifetime: a confirmation is valid for 10 minutes (docs/specs/corpus-callosum.md). */
export const REQUEST_TTL_MS = 10 * 60_000
/** The window of a room, in ms per minute. */
const MINUTE_MS = 60_000

export function roomsRepo(sqlite: Sqlite): RoomsRepo {
  const getRoom = (id: string): RoomRecord | undefined => {
    const row = sqlite
      .query<RoomRow, [string]>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = ?`)
      .get(id)
    return row === null ? undefined : toRoom(row)
  }

  const getMember = (roomId: string, personId: string): MemberRecord | undefined => {
    const row = sqlite
      .query<MemberRow, [string, string]>(
        `SELECT ${MEMBER_COLUMNS} FROM room_members WHERE room_id = ? AND person_id = ?`,
      )
      .get(roomId, personId)
    return row === null ? undefined : toMember(row)
  }

  const setMemberStatus = (
    roomId: string,
    personId: string,
    status: MemberStatus,
    fields: {
      invitedBy?: string | null
      invitedAt?: number
      joinedAt?: number | null
      leftAt?: number | null
      leaveReason?: string | null
    },
  ): void => {
    const current = getMember(roomId, personId)
    if (current === undefined) return
    sqlite
      .query(
        `UPDATE room_members SET status = ?, invited_by = ?, invited_at = ?, joined_at = ?, left_at = ?, leave_reason = ?
         WHERE room_id = ? AND person_id = ?`,
      )
      .run(
        status,
        fields.invitedBy === undefined ? current.invitedBy : fields.invitedBy,
        fields.invitedAt ?? current.invitedAt,
        fields.joinedAt === undefined ? current.joinedAt : fields.joinedAt,
        fields.leftAt === undefined ? current.leftAt : fields.leftAt,
        fields.leaveReason === undefined ? current.leaveReason : fields.leaveReason,
        roomId,
        personId,
      )
  }

  const activeElsewhere = (personId: string, roomId: string): boolean =>
    sqlite
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM room_members WHERE person_id = ? AND status = 'active' AND room_id <> ?`,
      )
      .get(personId, roomId)?.n !== 0

  const insertEvent = (input: NewEvent): number => {
    const text = input.text ?? null
    if (text !== null && [...text].length > ROOM_TEXT_MAX)
      throw new RangeError(`room text is over ${ROOM_TEXT_MAX} characters`)
    const result = sqlite
      .query(
        `INSERT INTO room_events (room_id, at, kind, speaker, text, data) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roomId,
        input.at,
        input.kind,
        input.speaker ?? null,
        text,
        input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      )
    return Number(result.lastInsertRowid)
  }

  const readEvents = (sql: string, params: (string | number)[]): EventRecord[] =>
    sqlite
      .query<EventRow, (string | number)[]>(sql)
      .all(...params)
      .map(toEvent)

  const readRequest = (id: string): RequestRecord | undefined => {
    const row = sqlite
      .query<RequestRow, [string]>(`SELECT ${REQUEST_COLUMNS} FROM room_requests WHERE id = ?`)
      .get(id)
    return row === null ? undefined : toRequest(row)
  }

  return {
    create(input, at) {
      return immediate(sqlite, () => {
        if (activeElsewhere(input.initiator, input.id)) return { status: 'busy' }
        sqlite
          .query(
            `INSERT INTO rooms (id, name, initiator, state, answer_mode, window_minutes, window_events, transport, generation, created_at)
             VALUES (?, ?, ?, 'open', ?, ?, ?, 'text', 1, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.initiator,
            input.answerMode,
            input.windowMinutes,
            input.windowEvents,
            at,
          )
        sqlite
          .query(
            `INSERT INTO room_members (room_id, person_id, status, invited_at, joined_at)
             VALUES (?, ?, 'active', ?, ?)`,
          )
          .run(input.id, input.initiator, at, at)
        const room = getRoom(input.id)
        if (room === undefined) throw new Error('room was not written')
        return { status: 'created', room }
      })
    },
    get: getRoom,
    list(limit) {
      return sqlite
        .query<RoomRow, [number]>(
          `SELECT ${ROOM_COLUMNS} FROM rooms ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit)
        .map(toRoom)
    },
    activeRoomOf(personId) {
      const row = sqlite
        .query<RoomRow, [string]>(
          `SELECT r.id, r.name, r.initiator, r.state, r.answer_mode, r.window_minutes, r.window_events, r.transport,
             r.generation, r.created_at, r.started_at, r.ended_at, r.ended_by, r.end_reason
           FROM room_members m JOIN rooms r ON r.id = m.room_id
           WHERE m.person_id = ? AND m.status = 'active' LIMIT 1`,
        )
        .get(personId)
      return row === null ? undefined : toRoom(row)
    },
    roomsOf(personId, limit) {
      const rows = sqlite
        .query<MemberRow, [string, number]>(
          `SELECT ${MEMBER_COLUMNS} FROM room_members WHERE person_id = ?
           ORDER BY invited_at DESC, room_id DESC LIMIT ?`,
        )
        .all(personId, limit)
      const out: { room: RoomRecord; member: MemberRecord }[] = []
      for (const row of rows) {
        const room = getRoom(row.room_id)
        if (room !== undefined) out.push({ room, member: toMember(row) })
      }
      return out
    },
    members(roomId) {
      return sqlite
        .query<MemberRow, [string]>(
          `SELECT ${MEMBER_COLUMNS} FROM room_members WHERE room_id = ? ORDER BY invited_at, person_id`,
        )
        .all(roomId)
        .map(toMember)
    },
    member: getMember,
    invite(roomId, personId, invitedBy, at) {
      return immediate(sqlite, (): InviteResult => {
        const room = getRoom(roomId)
        if (room === undefined || room.state === 'ended') return 'refused'
        const current = getMember(roomId, personId)
        if (current === undefined) {
          sqlite
            .query(
              `INSERT INTO room_members (room_id, person_id, status, invited_by, invited_at) VALUES (?, ?, 'invited', ?, ?)`,
            )
            .run(roomId, personId, invitedBy, at)
          return 'invited'
        }
        if (current.status === 'invited' || current.status === 'active') return 'exists'
        if (current.status === 'removed') return 'refused'
        setMemberStatus(roomId, personId, 'invited', {
          invitedBy,
          invitedAt: at,
          joinedAt: null,
          leftAt: null,
          leaveReason: null,
        })
        return 'invited'
      })
    },
    accept(roomId, personId, at) {
      return immediate(sqlite, (): MoveResult => {
        const room = getRoom(roomId)
        const current = getMember(roomId, personId)
        if (room === undefined || room.state === 'ended') return 'stale'
        if (current === undefined || current.status !== 'invited') return 'stale'
        if (activeElsewhere(personId, roomId)) return 'busy'
        setMemberStatus(roomId, personId, 'active', {
          joinedAt: at,
          leftAt: null,
          leaveReason: null,
        })
        if (room.state === 'open') {
          sqlite
            .query(`UPDATE rooms SET state = 'active', started_at = ? WHERE id = ?`)
            .run(at, roomId)
        }
        return 'moved'
      })
    },
    decline(roomId, personId) {
      return immediate(sqlite, (): MoveResult => {
        const current = getMember(roomId, personId)
        if (current === undefined || current.status !== 'invited') return 'stale'
        setMemberStatus(roomId, personId, 'declined', {})
        return 'moved'
      })
    },
    expireInvites(before) {
      return sqlite
        .query(
          `UPDATE room_members SET status = 'expired' WHERE status = 'invited' AND invited_at < ?`,
        )
        .run(before).changes
    },
    leave(roomId, personId, status, reason, at) {
      return immediate(sqlite, (): MoveResult => {
        const current = getMember(roomId, personId)
        if (current === undefined || current.status !== 'active') return 'stale'
        setMemberStatus(roomId, personId, status, { leftAt: at, leaveReason: reason })
        return 'moved'
      })
    },
    end(roomId, endedBy, reason, at) {
      return immediate(sqlite, (): EndResult => {
        const room = getRoom(roomId)
        if (room === undefined || room.state === 'ended') return 'stale'
        sqlite
          .query(
            `UPDATE rooms SET state = 'ended', ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?`,
          )
          .run(at, endedBy, reason, roomId)
        sqlite
          .query(
            `UPDATE room_members SET status = 'left', left_at = ?, leave_reason = 'ended'
             WHERE room_id = ? AND status = 'active'`,
          )
          .run(at, roomId)
        sqlite
          .query(
            `UPDATE room_members SET status = 'expired' WHERE room_id = ? AND status = 'invited'`,
          )
          .run(roomId)
        sqlite
          .query(
            `UPDATE room_requests SET status = 'expired' WHERE room_id = ? AND status = 'pending'`,
          )
          .run(roomId)
        return 'ended'
      })
    },
    bumpGeneration(roomId) {
      return immediate(sqlite, () => {
        sqlite.query(`UPDATE rooms SET generation = generation + 1 WHERE id = ?`).run(roomId)
        return getRoom(roomId)?.generation
      })
    },
    appendEvent: insertEvent,
    window(roomId, now) {
      const room = getRoom(roomId)
      if (room === undefined) return []
      const since = now - room.windowMinutes * MINUTE_MS
      return readEvents(
        `SELECT ${EVENT_COLUMNS} FROM (
           SELECT ${EVENT_COLUMNS} FROM room_events WHERE room_id = ? AND at >= ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`,
        [roomId, since, room.windowEvents],
      )
    },
    eventsForMember(roomId, personId, after, limit) {
      return readEvents(
        `SELECT e.seq, e.room_id, e.at, e.kind, e.speaker, e.text, e.data
         FROM room_events e JOIN room_members m ON m.room_id = e.room_id AND m.person_id = ?
         WHERE e.room_id = ? AND e.seq > ? AND m.joined_at IS NOT NULL
           AND m.status IN ('active', 'left', 'removed')
           AND e.at >= m.joined_at
           AND (m.left_at IS NULL OR e.at < m.left_at
                OR (e.at = m.left_at AND e.kind IN (${MEMBERSHIP_EVENTS.map(() => '?').join(', ')})))
         ORDER BY e.seq LIMIT ?`,
        [personId, roomId, after, ...MEMBERSHIP_EVENTS, limit],
      )
    },
    eventsForOwner(roomId, after, limit) {
      return readEvents(
        `SELECT ${EVENT_COLUMNS} FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        [roomId, after, limit],
      )
    },
    createRequest(input) {
      sqlite
        .query(
          `INSERT INTO room_requests (id, room_id, person, kind, payload, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          input.id,
          input.roomId,
          input.person,
          input.kind,
          input.payload === undefined || input.payload === null
            ? null
            : JSON.stringify(input.payload),
          input.createdAt,
          input.expiresAt,
        )
      const request = readRequest(input.id)
      if (request === undefined) throw new Error('request was not written')
      return request
    },
    request: readRequest,
    pendingRequests(person, now) {
      return sqlite
        .query<RequestRow, [string, number]>(
          `SELECT ${REQUEST_COLUMNS} FROM room_requests
           WHERE person = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, id`,
        )
        .all(person, now)
        .map(toRequest)
    },
    pendingInRoom(roomId, now) {
      return sqlite
        .query<RequestRow, [string, number]>(
          `SELECT ${REQUEST_COLUMNS} FROM room_requests
           WHERE room_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, id`,
        )
        .all(roomId, now)
        .map(toRequest)
    },
    decideRequest(id, to, at) {
      return immediate(sqlite, (): DecideResult => {
        const current = readRequest(id)
        if (current === undefined || current.status !== 'pending') return 'stale'
        if (current.expiresAt <= at) {
          sqlite.query(`UPDATE room_requests SET status = 'expired' WHERE id = ?`).run(id)
          return 'expired'
        }
        sqlite.query(`UPDATE room_requests SET status = ? WHERE id = ?`).run(to, id)
        return 'decided'
      })
    },
    expireRequests(now) {
      return sqlite
        .query(
          `UPDATE room_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
        )
        .run(now).changes
    },
  }
}
