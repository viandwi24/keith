import { z } from 'zod'
import { BudgetStatusSchema } from './budget.ts'
import {
  CHAT_CONTEXT_CHANGED,
  CHAT_CONTEXT_PENDING,
  ChatContextChangedRecordSchema,
  ChatContextPendingRecordSchema,
} from './chat-context.ts'
import { DELIVERY_FAILED, DeliveryFailedRecordSchema } from './delivery.ts'
import { NODE_CHANGED, NodeChangedPayloadSchema } from './nodes.ts'
import { PERSONA_CHANGED, PersonaChangedRecordSchema } from './persona.ts'
import { RoomIdSchema } from './rooms.ts'
import { TASK_CHANGED, TaskChangedPayloadSchema } from './tasks.ts'

/** The activity-feed type of the record that says a person's access changed. */
export const IDENTITY_CHANGED = 'identity.changed' as const

/** Why a person's access changed (docs/specs/thalamus.md, "Activity feed records"). */
export const IdentityChangedReasonSchema = z.enum([
  'grant',
  'revoke',
  'suspend',
  'role',
  'transfer',
  'remove',
  'can_login',
  'credential',
])
export type IdentityChangedReason = z.infer<typeof IdentityChangedReasonSchema>

/**
 * Payload of `identity.changed`: written on the affected person's own front session, so the feed
 * shows it to that person only. It names the person and the reason, nothing else.
 */
export const IdentityChangedRecordSchema = z.object({
  personId: z.string(),
  reason: IdentityChangedReasonSchema,
})
export type IdentityChangedRecord = z.infer<typeof IdentityChangedRecordSchema>

/**
 * The activity-feed type of a shared-room event: one record per active member, `{ to, roomId, seq }`, no text
 * (corpus-callosum.md "Transport"). The client refetches the transcript with `rooms.events`.
 */
export const ROOM_EVENT = 'room.event' as const

/**
 * Payload of `room.event`: the recipient (`to`, one record per active member), the room and the transcript position. It holds
 * no text: the client refetches `rooms.events({ roomId, after })`, which enforces membership and `left_at`.
 */
export const RoomEventRecordSchema = z.object({
  to: z.string().min(1),
  roomId: RoomIdSchema,
  seq: z.number().int().min(1),
})
export type RoomEventRecord = z.infer<typeof RoomEventRecordSchema>

/**
 * The activity-feed type of a room's indicator change: one record per active member, `{ to, roomId }`, no text and no
 * indicator value (corpus-callosum.md "Transport"). The client refetches `rooms.get`, which carries the indicator.
 */
export const ROOM_INDICATOR = 'room.indicator' as const

/**
 * Payload of `room.indicator`: the recipient (`to`, one record per active member) and the room. It holds no indicator: a
 * member who reads it refetches `rooms.get` and sees the indicator only as a member.
 */
export const RoomIndicatorRecordSchema = z.object({
  to: z.string().min(1),
  roomId: RoomIdSchema,
})
export type RoomIndicatorRecord = z.infer<typeof RoomIndicatorRecordSchema>

/** The activity-feed type of a budget change (docs/specs/budget.md). */
export const BUDGET_CHANGED = 'budget-changed' as const

/**
 * Payload of `budget-changed`: the status the record's audience sees. The global limit writes it with no
 * session (the owner's system record); a person's cap writes it on that person's front session, and `emit`
 * stamps `personId` into it.
 */
export const BudgetChangedRecordSchema = z.object({
  status: BudgetStatusSchema,
  personId: z.string().optional(),
})
export type BudgetChangedRecord = z.infer<typeof BudgetChangedRecordSchema>

/**
 * The payload schema of every activity record that has a Keith contract, by record type (the table in
 * docs/specs/thalamus.md, "Activity feed records"). Brain events (`brain.*`, `brain.ts`), plugin events
 * (`plugin.<id>.<event>`, `plugin-events.ts`) and the library's session records (eharness `activity()`)
 * have their own contracts and are not listed here.
 */
export const ACTIVITY_RECORD_SCHEMAS = {
  [NODE_CHANGED]: NodeChangedPayloadSchema,
  [BUDGET_CHANGED]: BudgetChangedRecordSchema,
  [TASK_CHANGED]: TaskChangedPayloadSchema,
  [IDENTITY_CHANGED]: IdentityChangedRecordSchema,
  [DELIVERY_FAILED]: DeliveryFailedRecordSchema,
  [ROOM_EVENT]: RoomEventRecordSchema,
  [ROOM_INDICATOR]: RoomIndicatorRecordSchema,
  [PERSONA_CHANGED]: PersonaChangedRecordSchema,
  [CHAT_CONTEXT_CHANGED]: ChatContextChangedRecordSchema,
  [CHAT_CONTEXT_PENDING]: ChatContextPendingRecordSchema,
} as const
