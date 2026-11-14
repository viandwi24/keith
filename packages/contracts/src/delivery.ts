import { z } from 'zod'

/**
 * The delivery service (docs/specs/delivery.md, ADR-0024 §5, ADR-0027 §16): one way for the core to tell a person
 * something (a due reminder, later a protocol step). Delivery is exactly once by run id.
 */

/** Activity-feed type of the record a person gets when a delivery to them finally failed (no text). */
export const DELIVERY_FAILED = 'delivery.failed' as const

/** How a delivery reaches the person: a turn, or a stored message with no turn and no cost. */
export const DeliveryModeSchema = z.enum(['wake', 'note'])
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>

/**
 * What the delivery needs from its route. `capabilities` (at most 5) are client capabilities the route must offer,
 * all of them (P27, e.g. `open.view`, `notify`); `fanout: 'all'` sends to every route the planner returns (P29).
 */
export const DeliveryNeedsSchema = z.object({
  mode: DeliveryModeSchema.default('wake'),
  capabilities: z.array(z.string().min(1).max(60)).max(5).default([]),
  fanout: z.enum(['best', 'all']).default('best'),
  urgency: z.enum(['normal', 'high']).default('normal'),
})
export type DeliveryNeeds = z.infer<typeof DeliveryNeedsSchema>

/** The most characters of a delivery run id; it is also the inject key of the wake turn (max 200 there). */
export const DELIVERY_ID_MAX = 200

/**
 * The failure notice of a delivery: a second delivery to `to` (the creator) with the run id `report:<key>`, stored as a
 * note. `key` makes the notice once per key (the reminders plugin puts the reminder id and the UTC day in it).
 */
export const DeliveryFailureNoticeSchema = z.object({
  to: z.string().min(1),
  text: z.string().min(1).max(1000),
  key: z.string().min(1).max(120),
})
export type DeliveryFailureNotice = z.infer<typeof DeliveryFailureNoticeSchema>

export const DeliveryRequestSchema = z.object({
  /** The run id: stable per fire. A second delivery with the same id returns the stored outcome and sends nothing. */
  id: z.string().min(1).max(DELIVERY_ID_MAX),
  /** Who asks: `plugin:reminders` now, `protocol:<id>` later (P28). */
  source: z.string().min(1).max(80),
  /** The recipient (a person id). */
  to: z.string().min(1),
  /** The person who pays for the turn when it is not the recipient (`billTo`, ADR-0024 §3). */
  billTo: z.string().min(1).optional(),
  /** The `eh.event` name the model sees. */
  name: z.string().min(1).max(60),
  text: z.string().min(1).max(4000),
  data: z.unknown().optional(),
  needs: DeliveryNeedsSchema.default({
    mode: 'wake',
    capabilities: [],
    fanout: 'best',
    urgency: 'normal',
  }),
  onFailure: DeliveryFailureNoticeSchema.optional(),
})
export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>
export type DeliveryRequestInput = z.input<typeof DeliveryRequestSchema>

/** Why a delivery did not reach the person. `budget` and `recipient-gone` are terminal (no retry). */
export const DeliveryFailReasonSchema = z.enum([
  'budget',
  'unavailable',
  'recipient-gone',
  'no-route',
])
export type DeliveryFailReason = z.infer<typeof DeliveryFailReasonSchema>

/** What `deliver()` returns: the outcome of the run id, stored, so a repeat call answers the same. */
export const DeliveryOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('delivered'), route: z.string(), attempts: z.number().int() }),
  z.object({
    status: z.literal('queued'),
    reason: z.literal('unavailable'),
    nextAttemptAt: z.number(),
  }),
  z.object({
    status: z.literal('failed'),
    reason: DeliveryFailReasonSchema,
    attempts: z.number().int(),
  }),
])
export type DeliveryOutcome = z.infer<typeof DeliveryOutcomeSchema>

/**
 * Payload of the activity record `delivery.failed`: written on the recipient's own front session when a delivery
 * finally failed. It names the run and the reason; the text never leaves the delivery row.
 */
export const DeliveryFailedRecordSchema = z.object({
  personId: z.string().min(1),
  deliveryId: z.string().min(1),
  source: z.string().min(1),
  reason: DeliveryFailReasonSchema,
})
export type DeliveryFailedRecord = z.infer<typeof DeliveryFailedRecordSchema>

/**
 * The most characters of an owner's test notice (`keith-core notify`, `admin.notice.send`). It equals the `notify` client
 * capability's limit (`NOTIFY_TEXT_MAX` in the core), so the toast never clips the text.
 */
export const NOTICE_TEXT_MAX = 500

/** Input of `admin.notice.send`: the owner's test notice to one person, sent through the real delivery path. */
export const AdminNoticeSendSchema = z.object({
  person: z.string().min(1).max(100),
  text: z.string().min(1).max(NOTICE_TEXT_MAX),
})
export type AdminNoticeSend = z.infer<typeof AdminNoticeSendSchema>

/** Output of `admin.notice.send`: the run id, the recipient's person id and the outcome of the delivery. */
export const AdminNoticeSentSchema = z.object({
  id: z.string().min(1),
  to: z.string().min(1),
  outcome: DeliveryOutcomeSchema,
})
export type AdminNoticeSent = z.infer<typeof AdminNoticeSentSchema>
