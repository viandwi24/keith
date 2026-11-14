// The shared-room tables of the corpus callosum (docs/specs/corpus-callosum.md, "Data model", ADR-0026, P30.1.3): a room
// with its members, the transcript of its events, and the confirmations a model cannot apply by itself. Person ids are
// plain text, not foreign keys to `people` (a removed person's rows follow the removal registry, ADR-0027 §26); the room
// tables reference their room, which is never deleted by the service (rooms are kept, ADR-0021 consequences).
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * A room: `state` is `open` (invitations out, only the initiator joined), `active` (after the first acceptance) or
 * `ended`. `generation` changes only on a session rollover (a new window starts, no memory). `window_minutes` and
 * `window_events` are the window the room agent reads; `transport` is `text` in this version.
 */
export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** The person who started the call (a person id, no foreign key). */
    initiator: text('initiator').notNull(),
    state: text('state').notNull(),
    /** `addressed` (a turn for messages that name Keith) or `every` (a turn for each message). */
    answerMode: text('answer_mode').notNull().default('addressed'),
    windowMinutes: integer('window_minutes').notNull().default(30),
    windowEvents: integer('window_events').notNull().default(200),
    transport: text('transport').notNull().default('text'),
    generation: integer('generation').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    endedBy: text('ended_by'),
    endReason: text('end_reason'),
  },
  (t) => [
    check('rooms_state_known', sql`${t.state} IN ('open', 'active', 'ended')`),
    check('rooms_answer_mode_known', sql`${t.answerMode} IN ('addressed', 'every')`),
    check('rooms_transport_known', sql`${t.transport} IN ('text')`),
  ],
)

/**
 * A person in a room. `status` is `invited`, `active`, `declined`, `left`, `removed` or `expired`; the initiator is `active`
 * from the start. A person is `active` in at most one room (the partial unique index), so a second active row is refused by
 * the database as well as by the repo. `left_at` is the last moment the member may read the transcript.
 */
export const roomMembers = sqliteTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    personId: text('person_id').notNull(),
    status: text('status').notNull(),
    invitedBy: text('invited_by'),
    invitedAt: integer('invited_at').notNull(),
    joinedAt: integer('joined_at'),
    leftAt: integer('left_at'),
    leaveReason: text('leave_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.personId] }),
    index('room_members_person_status').on(t.personId, t.status),
    uniqueIndex('room_members_one_active').on(t.personId).where(sql`${t.status} = 'active'`),
    check(
      'room_members_status_known',
      sql`${t.status} IN ('invited', 'active', 'declined', 'left', 'removed', 'expired')`,
    ),
  ],
)

/**
 * The transcript of a room: every message, turn marker and membership change, in `seq` order. The only source of the
 * window and of what a member may read. `speaker` is a person id, `keith`, or null; `text` is at most 2000 characters and
 * `data` is JSON without message text. Kept with the room.
 */
export const roomEvents = sqliteTable(
  'room_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    speaker: text('speaker'),
    text: text('text'),
    data: text('data'),
  },
  (t) => [
    index('room_events_room_seq').on(t.roomId, t.seq),
    index('room_events_room_at').on(t.roomId, t.at),
    check(
      'room_events_kind_known',
      sql`${t.kind} IN ('say', 'keith', 'join', 'leave', 'remove', 'end', 'system', 'handoff', 'post')`,
    ),
  ],
)

/**
 * A confirmation a human must give: a model can only create one (`kind` `remove`, `end` or `post`), the person it belongs
 * to decides it over RPC. `status` is `pending`, `confirmed`, `refused` or `expired`; a pending row past `expires_at`
 * (10 minutes) is expired and cannot be confirmed.
 */
export const roomRequests = sqliteTable(
  'room_requests',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    person: text('person').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload'),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('room_requests_person_status').on(t.person, t.status),
    index('room_requests_status_expires').on(t.status, t.expiresAt),
    check('room_requests_kind_known', sql`${t.kind} IN ('remove', 'end', 'post')`),
    check(
      'room_requests_status_known',
      sql`${t.status} IN ('pending', 'confirmed', 'refused', 'expired')`,
    ),
  ],
)
