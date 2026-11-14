// Shared rooms, the group call with Keith (docs/specs/corpus-callosum.md, ADR-0026). Re-exported by area-runtime.ts.
// The shapes a person sees (no ids of other rooms, no internal generation, no transcript text in a header) and the RPC
// input and output schemas. The procedures themselves are declared in contract.ts (P30.2.5).
import { z } from 'zod'

export const ROOM_NAME_MAX = 60
export const ROOM_TEXT_MAX = 2000
export const ROOM_HANDOFF_MAX = 1000
export const ROOM_REASON_MAX = 200
export const ROOM_INVITE_MIN = 1
export const ROOM_INVITE_MAX = 16
export const ROOM_WINDOW_MINUTES_MIN = 1
export const ROOM_WINDOW_MINUTES_MAX = 240
export const ROOM_WINDOW_EVENTS_MIN = 10
export const ROOM_WINDOW_EVENTS_MAX = 1000
export const ROOM_LIST_LIMIT_MAX = 200
/** A pending confirmation (remove, end, post) expires after this long and changes nothing. */
export const ROOM_REQUEST_TTL_MS = 10 * 60_000

export const RoomIdSchema = z.string().uuid()
export type RoomId = z.infer<typeof RoomIdSchema>

/** `open`: invitations out, nobody but the initiator joined; `active`: after the first acceptance; `ended`: final. */
export const RoomStateSchema = z.enum(['open', 'active', 'ended'])
export type RoomState = z.infer<typeof RoomStateSchema>

/** `addressed`: a turn only for `@keith` or a reply to Keith; `every`: a turn for each message. */
export const RoomAnswerModeSchema = z.enum(['addressed', 'every'])
export type RoomAnswerMode = z.infer<typeof RoomAnswerModeSchema>

export const RoomMemberStatusSchema = z.enum([
  'invited',
  'active',
  'declined',
  'left',
  'removed',
  'expired',
])
export type RoomMemberStatus = z.infer<typeof RoomMemberStatusSchema>

export const RoomEventKindSchema = z.enum([
  'say',
  'keith',
  'join',
  'leave',
  'remove',
  'end',
  'system',
  'handoff',
  'post',
])
export type RoomEventKind = z.infer<typeof RoomEventKindSchema>

export const RoomRequestKindSchema = z.enum(['remove', 'end', 'post'])
export type RoomRequestKind = z.infer<typeof RoomRequestKindSchema>

export const RoomRequestStatusSchema = z.enum(['pending', 'confirmed', 'refused', 'expired'])
export type RoomRequestStatus = z.infer<typeof RoomRequestStatusSchema>

/** Only the text adapter exists now; audio and video are later adapters behind `RoomTransport`. */
export const RoomTransportKindSchema = z.literal('text')
export type RoomTransportKind = z.infer<typeof RoomTransportKindSchema>

/** A person as the room shows them: id and display name. Keith is `{ id: 'keith', name: 'Keith' }`. */
export const RoomPersonSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
})
export type RoomPerson = z.infer<typeof RoomPersonSchema>

export const RoomNameSchema = z.string().trim().min(1).max(ROOM_NAME_MAX)

export const RoomSchema = z.object({
  id: RoomIdSchema,
  name: z.string().min(1).max(ROOM_NAME_MAX),
  initiator: RoomPersonSchema,
  state: RoomStateSchema,
  answerMode: RoomAnswerModeSchema,
  windowMinutes: z.number().int().min(ROOM_WINDOW_MINUTES_MIN).max(ROOM_WINDOW_MINUTES_MAX),
  windowEvents: z.number().int().min(ROOM_WINDOW_EVENTS_MIN).max(ROOM_WINDOW_EVENTS_MAX),
  transport: RoomTransportKindSchema,
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  endedBy: RoomPersonSchema.nullable(),
  endReason: z.string().max(ROOM_REASON_MAX).nullable(),
})
export type Room = z.infer<typeof RoomSchema>

export const RoomMemberSchema = z.object({
  person: RoomPersonSchema,
  status: RoomMemberStatusSchema,
  invitedBy: RoomPersonSchema.nullable(),
  invitedAt: z.number().int(),
  joinedAt: z.number().int().nullable(),
  leftAt: z.number().int().nullable(),
  leaveReason: z.string().max(ROOM_REASON_MAX).nullable(),
})
export type RoomMember = z.infer<typeof RoomMemberSchema>

/**
 * One transcript line as a person reads it. `speaker` is null for system lines; `text` is null for a `handoff`
 * (its text is never written to the room). `data` is never sent.
 */
export const RoomEventSchema = z.object({
  seq: z.number().int().min(1),
  at: z.number().int(),
  kind: RoomEventKindSchema,
  speaker: RoomPersonSchema.nullable(),
  text: z.string().max(ROOM_TEXT_MAX).nullable(),
})
export type RoomEvent = z.infer<typeof RoomEventSchema>

/** A room header: no transcript text. What the owner sees of every room, and what the CLI prints. */
export const RoomHeaderSchema = z.object({
  room: RoomSchema,
  members: z.array(RoomMemberSchema),
})
export type RoomHeader = z.infer<typeof RoomHeaderSchema>

/** The invitation a person sees (toast and Home notice): accept or decline before `expiresAt`. */
export const RoomInviteSchema = z.object({
  roomId: RoomIdSchema,
  roomName: z.string().min(1).max(ROOM_NAME_MAX),
  initiator: RoomPersonSchema,
  invitedAt: z.number().int(),
  expiresAt: z.number().int(),
})
export type RoomInvite = z.infer<typeof RoomInviteSchema>

/** A pending confirmation. `person` is the one who confirms; `payload` holds the target (remove) or the exact text (post). */
export const RoomRequestSchema = z.object({
  id: z.string().min(1).max(80),
  roomId: RoomIdSchema,
  kind: RoomRequestKindSchema,
  status: RoomRequestStatusSchema,
  person: z.string().min(1).max(80),
  payload: z.object({
    target: RoomPersonSchema.optional(),
    text: z.string().max(ROOM_TEXT_MAX).optional(),
  }),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
})
export type RoomRequest = z.infer<typeof RoomRequestSchema>

/** The indicator of the text adapter (ADR-0026 §6). Held in memory, never stored. */
export const RoomIndicatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('speaking'), to: z.string().max(120).optional() }),
  z.object({ kind: z.literal('listening'), who: z.string().min(1).max(120) }),
])
export type RoomIndicator = z.infer<typeof RoomIndicatorSchema>

/** The port of ADR-0026 §6. The text and indicator adapter implements it; audio and video are later adapters. */
export interface RoomTransport {
  join(roomId: string, personId: string): Promise<void>
  leave(roomId: string, personId: string, reason: 'left' | 'removed' | 'ended'): Promise<void>
  say(roomId: string, from: string | 'keith', text: string): Promise<void>
  indicator(roomId: string, state: RoomIndicator): Promise<void>
  end(roomId: string, reason: string): Promise<void>
}

/** The presence of a member when the caller may not read it: a member who released none, an invitee, or a caller who is no member. */
export const ROOM_PRESENCE_NOT_SHARED = 'not shared' as const

/**
 * A member as one caller sees it. `presence` is the disclosed presence line of the member as the caller may read it (P27,
 * `disclosedFor`), or `not shared` (see ROOM_PRESENCE_NOT_SHARED). Only an active member reads presence of the active members.
 */
export const RoomViewMemberSchema = RoomMemberSchema.extend({
  presence: z.string().min(1).max(500),
})
export type RoomViewMember = z.infer<typeof RoomViewMemberSchema>

/** A room as one person sees it: the header, the members with presence, the indicator, what the caller may do, and the requests the caller may confirm. */
export const RoomViewSchema = z.object({
  room: RoomSchema,
  members: z.array(RoomViewMemberSchema),
  /** The indicator of the text adapter (`idle` for a caller who is no active member). */
  indicator: RoomIndicatorSchema,
  you: z.object({
    status: RoomMemberStatusSchema.nullable(),
    isInitiator: z.boolean(),
    canSpeak: z.boolean(),
    canControl: z.boolean(),
  }),
  /**
   * The pending requests of this room the caller may confirm: the ones that name the caller, and for a `remove` or an `end` the
   * owner's too (the rule of `rooms.confirm`; a `post` is only ever the person's own).
   */
  pending: z.array(RoomRequestSchema),
})
export type RoomView = z.infer<typeof RoomViewSchema>

/** The success answer of a call with nothing to return. */
export const RoomsOkSchema = z.object({ ok: z.literal(true) })
export type RoomsOk = z.infer<typeof RoomsOkSchema>

const RoomRefSchema = z.object({ roomId: RoomIdSchema })
/** Person refs as every person call takes them: a username or an id (`PersonRefSchema`, people.ts). */
const PersonRefValueSchema = z.string().min(1).max(100)
const InviteeListSchema = z.array(PersonRefValueSchema).min(ROOM_INVITE_MIN).max(ROOM_INVITE_MAX)

export const RoomsStartInputSchema = z.object({
  name: RoomNameSchema.optional(),
  invite: InviteeListSchema,
})
export type RoomsStartInput = z.infer<typeof RoomsStartInputSchema>

export const RoomsInviteInputSchema = RoomRefSchema.extend({ invite: InviteeListSchema })
export type RoomsInviteInput = z.infer<typeof RoomsInviteInputSchema>

export const RoomsAcceptInputSchema = RoomRefSchema
export const RoomsDeclineInputSchema = RoomRefSchema
export const RoomsLeaveInputSchema = RoomRefSchema

export const RoomsSayInputSchema = RoomRefSchema.extend({
  text: z.string().trim().min(1).max(ROOM_TEXT_MAX),
  /** The TUI sets it when the message replies to a Keith line; it starts a turn in `addressed` mode. */
  replyToKeith: z.boolean().optional(),
})
export type RoomsSayInput = z.infer<typeof RoomsSayInputSchema>

/** `queued`: the message waits behind another turn. `addressed`: the message starts a turn. */
export const RoomsSayOutputSchema = z.object({
  seq: z.number().int().min(1),
  queued: z.boolean(),
  addressed: z.boolean(),
})
export type RoomsSayOutput = z.infer<typeof RoomsSayOutputSchema>

export const RoomsRemoveInputSchema = RoomRefSchema.extend({ person: PersonRefValueSchema })
export type RoomsRemoveInput = z.infer<typeof RoomsRemoveInputSchema>

export const RoomsEndInputSchema = RoomRefSchema.extend({
  reason: z.string().trim().min(1).max(ROOM_REASON_MAX).optional(),
})
export type RoomsEndInput = z.infer<typeof RoomsEndInputSchema>

/** `approved` is the person's own key press: true posts or removes, false refuses. */
export const RoomsConfirmInputSchema = z.object({
  requestId: z.string().min(1).max(80),
  approved: z.boolean(),
})
export type RoomsConfirmInput = z.infer<typeof RoomsConfirmInputSchema>

export const RoomsConfirmOutputSchema = z.object({
  status: z.enum(['confirmed', 'refused']),
})
export type RoomsConfirmOutput = z.infer<typeof RoomsConfirmOutputSchema>

export const RoomsGetInputSchema = RoomRefSchema

export const RoomsListInputSchema = z.object({
  limit: z.number().int().min(1).max(ROOM_LIST_LIMIT_MAX).optional(),
})
export type RoomsListInput = z.infer<typeof RoomsListInputSchema>

/**
 * A room in the caller's list: the header, and the expiry of the caller's own invitation (`invitedAt` plus
 * `rooms.inviteTtlMinutes`), or null when the caller is not invited to it. The invitee's toast reads it, not a default.
 */
export const RoomListItemSchema = RoomHeaderSchema.extend({
  inviteExpiresAt: z.number().int().nullable(),
})
export type RoomListItem = z.infer<typeof RoomListItemSchema>

export const RoomsListOutputSchema = z.object({ rooms: z.array(RoomListItemSchema) })
export type RoomsListOutput = z.infer<typeof RoomsListOutputSchema>

export const RoomsEventsInputSchema = RoomRefSchema.extend({
  /** Return events with `seq` greater than this (the last seq the client holds). */
  after: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(ROOM_LIST_LIMIT_MAX).optional(),
})
export type RoomsEventsInput = z.infer<typeof RoomsEventsInputSchema>

export const RoomsEventsOutputSchema = z.object({
  events: z.array(RoomEventSchema),
  nextAfter: z.number().int().min(0),
})
export type RoomsEventsOutput = z.infer<typeof RoomsEventsOutputSchema>

/** A path inside `rooms/<roomId>/`: relative, no `..` segment. */
const RoomPathSchema = z
  .string()
  .max(512)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'a path inside the room folder: relative, no ".." segment',
  })

export const RoomsFilesInputSchema = RoomRefSchema.extend({ path: RoomPathSchema.optional() })
export type RoomsFilesInput = z.infer<typeof RoomsFilesInputSchema>

export const RoomFileSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().max(512),
  dir: z.boolean(),
  size: z.number().int().min(0),
})
export type RoomFile = z.infer<typeof RoomFileSchema>

export const RoomsFilesOutputSchema = z.object({ files: z.array(RoomFileSchema) })
export type RoomsFilesOutput = z.infer<typeof RoomsFilesOutputSchema>

/**
 * The room settings (settings repo, owner, docs/specs/corpus-callosum.md "Settings"). The window values are the defaults
 * copied into a new room; a room keeps its own. Bounds are checked on every write and on every read (a corrupt stored
 * value reads as the default).
 */
export const RoomSettingsSchema = z.object({
  maxMembers: z.number().int().min(2).max(ROOM_INVITE_MAX),
  inviteTtlMinutes: z.number().int().min(1).max(60),
  maxTurnsPerHour: z.number().int().min(1).max(600),
  maxQueue: z.number().int().min(1).max(50),
  windowMinutes: z.number().int().min(ROOM_WINDOW_MINUTES_MIN).max(ROOM_WINDOW_MINUTES_MAX),
  windowEvents: z.number().int().min(ROOM_WINDOW_EVENTS_MIN).max(ROOM_WINDOW_EVENTS_MAX),
})
export type RoomSettings = z.infer<typeof RoomSettingsSchema>

export const ROOM_SETTINGS_DEFAULTS: Readonly<RoomSettings> = {
  maxMembers: 8,
  inviteTtlMinutes: 10,
  maxTurnsPerHour: 60,
  maxQueue: 10,
  windowMinutes: 30,
  windowEvents: 200,
}

/** The owner's change of the settings: any of the six keys, at least one (`rooms.settings.set`, step-up from a remote caller). */
export const RoomSettingsSetSchema = RoomSettingsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'give at least one room setting' },
)
export type RoomSettingsSet = z.infer<typeof RoomSettingsSetSchema>
