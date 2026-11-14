// The row shapes and column lists of the shared-room tables, and the mappers from a row to its record (rooms.ts).
// The records are declared in rooms.ts; this file only reads the SQL rows into them.
import type {
  AnswerMode,
  EventData,
  EventKind,
  EventRecord,
  MemberRecord,
  MemberStatus,
  RequestKind,
  RequestRecord,
  RequestStatus,
  RoomRecord,
  RoomState,
} from './rooms.ts'

export interface RoomRow {
  id: string
  name: string
  initiator: string
  state: string
  answer_mode: string
  window_minutes: number
  window_events: number
  transport: string
  generation: number
  created_at: number
  started_at: number | null
  ended_at: number | null
  ended_by: string | null
  end_reason: string | null
}

export interface MemberRow {
  room_id: string
  person_id: string
  status: string
  invited_by: string | null
  invited_at: number
  joined_at: number | null
  left_at: number | null
  leave_reason: string | null
}

export interface EventRow {
  seq: number
  room_id: string
  at: number
  kind: string
  speaker: string | null
  text: string | null
  data: string | null
}

export interface RequestRow {
  id: string
  room_id: string
  person: string
  kind: string
  payload: string | null
  status: string
  created_at: number
  expires_at: number
}

export const ROOM_COLUMNS = `id, name, initiator, state, answer_mode, window_minutes, window_events, transport,
  generation, created_at, started_at, ended_at, ended_by, end_reason`
export const MEMBER_COLUMNS = `room_id, person_id, status, invited_by, invited_at, joined_at, left_at, leave_reason`
export const EVENT_COLUMNS = 'seq, room_id, at, kind, speaker, text, data'
export const REQUEST_COLUMNS = 'id, room_id, person, kind, payload, status, created_at, expires_at'

export const toRoom = (r: RoomRow): RoomRecord => ({
  id: r.id,
  name: r.name,
  initiator: r.initiator,
  state: r.state as RoomState,
  answerMode: r.answer_mode as AnswerMode,
  windowMinutes: r.window_minutes,
  windowEvents: r.window_events,
  transport: 'text',
  generation: r.generation,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  endedBy: r.ended_by,
  endReason: r.end_reason,
})

export const toMember = (r: MemberRow): MemberRecord => ({
  roomId: r.room_id,
  personId: r.person_id,
  status: r.status as MemberStatus,
  invitedBy: r.invited_by,
  invitedAt: r.invited_at,
  joinedAt: r.joined_at,
  leftAt: r.left_at,
  leaveReason: r.leave_reason,
})

export const toEvent = (r: EventRow): EventRecord => ({
  seq: r.seq,
  roomId: r.room_id,
  at: r.at,
  kind: r.kind as EventKind,
  speaker: r.speaker,
  text: r.text,
  data: r.data === null ? null : (JSON.parse(r.data) as EventData),
})

export const toRequest = (r: RequestRow): RequestRecord => ({
  id: r.id,
  roomId: r.room_id,
  person: r.person,
  kind: r.kind as RequestKind,
  payload: r.payload === null ? null : (JSON.parse(r.payload) as EventData),
  status: r.status as RequestStatus,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})
