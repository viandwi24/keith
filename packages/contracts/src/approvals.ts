import { z } from 'zod'

/** How long a pending approval waits for an answer, in hours (ADR-0027 §10; `approvals.ttlHours`). */
export const APPROVAL_TTL_DEFAULT_HOURS = 24
export const APPROVAL_TTL_MAX_HOURS = 168

/**
 * Hours before expiry at which the owner is pinged about a waiting approval (`approvals.pingBeforeHours`, spec
 * amygdala.md). It is at least 1 and always below the lifetime in force; that pair is checked by the setter, not here.
 */
export const APPROVAL_PING_DEFAULT_HOURS = 2

export const ApprovalTtlHoursSchema = z.number().int().min(1).max(APPROVAL_TTL_MAX_HOURS)
export const ApprovalPingHoursSchema = z.number().int().min(1).max(APPROVAL_TTL_MAX_HOURS)

/** The approval settings as read: the lifetime and the ping in force, with their defaults and the lifetime's maximum. */
export const ApprovalsSchema = z.object({
  ttlHours: z.number().int(),
  defaultHours: z.number().int(),
  maxHours: z.number().int(),
  pingBeforeHours: z.number().int(),
  defaultPingBeforeHours: z.number().int(),
})
export type Approvals = z.infer<typeof ApprovalsSchema>

/** A change of one or both values (at least one). The pair is checked by the core: the ping stays below the lifetime. */
export const ApprovalsSetSchema = z
  .object({
    ttlHours: ApprovalTtlHoursSchema.optional(),
    pingBeforeHours: ApprovalPingHoursSchema.optional(),
  })
  .refine(
    (change) => change.ttlHours !== undefined || change.pingBeforeHours !== undefined,
    'give ttlHours, pingBeforeHours or both',
  )
export type ApprovalsSet = z.infer<typeof ApprovalsSetSchema>
