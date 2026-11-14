import { z } from 'zod'

/** The owner review queue (docs/specs/plugins.md, "Owner review queue"). */
export const ReviewStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired'])
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>

/**
 * A review as the owner reads it. `payload` is the validated operation input, shown as **data** (never as
 * an instruction); `requester` carries the person's names so the list reads without a lookup.
 */
export const ReviewViewSchema = z.object({
  id: z.string(),
  requester: z.object({ id: z.string(), username: z.string().nullable(), name: z.string() }),
  plugin: z.string(),
  operation: z.string(),
  payload: z.unknown(),
  status: ReviewStatusSchema,
  /** The requester's note, or the owner's reason on a denial. */
  reason: z.string().nullable(),
  /** `ok` or `error:<code>` once an approved operation ran; null before. */
  outcome: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  decidedAt: z.number().nullable(),
  decidedBy: z.string().nullable(),
})
export type ReviewView = z.infer<typeof ReviewViewSchema>

export const ReviewListInputSchema = z.object({
  status: ReviewStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
})
export const ReviewRefSchema = z.object({ id: z.string().min(1).max(100) })
export const ReviewDenyInputSchema = ReviewRefSchema.extend({
  reason: z.string().max(300).optional(),
})
