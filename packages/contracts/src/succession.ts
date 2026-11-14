// The succession contracts (docs/specs/succession.md, ADR-0022 §3): the heir, the window, the pause and the heir's claim.
// Re-exported by area-runtime.ts. The procedures are in contract.ts under `admin.succession`.
import { z } from 'zod'
import { OwnerTransferredSchema, PersonRefSchema } from './people.ts'

const DAY_MS = 86_400_000

/** The window before the owner-absence protocol starts its grace (ADR-0022 §3: 14 days, the owner may set 7 to 90). */
export const SUCCESSION_WINDOW_MIN_DAYS = 7
export const SUCCESSION_WINDOW_MAX_DAYS = 90
export const SUCCESSION_WINDOW_DEFAULT_DAYS = 14
/** The grace period after the window is fixed by ADR-0022 §3; it is not a setting. */
export const SUCCESSION_GRACE_DAYS = 7
/** A pause for a long trip may run at most this long from the moment it is set. */
export const SUCCESSION_PAUSE_MAX_DAYS = 180

/** The states of the one `succession_state` row (succession.md, "States"). */
export const SuccessionStateSchema = z.enum(['idle', 'check-in', 'grace', 'claimable', 'claimed'])
export type SuccessionState = z.infer<typeof SuccessionStateSchema>

export const SuccessionWindowDaysSchema = z
  .number()
  .int()
  .min(SUCCESSION_WINDOW_MIN_DAYS)
  .max(SUCCESSION_WINDOW_MAX_DAYS)
export type SuccessionWindowDays = z.infer<typeof SuccessionWindowDaysSchema>

export const SuccessionSetWindowInputSchema = z.object({ days: SuccessionWindowDaysSchema })
export type SuccessionSetWindowInput = z.infer<typeof SuccessionSetWindowInputSchema>

/**
 * A pause ends after now and at most 180 days from now. The bound is checked when the input is parsed; the service
 * checks it again against its own clock.
 */
export const SuccessionPauseInputSchema = z
  .object({ until: z.number().int().positive() })
  .refine(
    (input) =>
      input.until > Date.now() && input.until <= Date.now() + SUCCESSION_PAUSE_MAX_DAYS * DAY_MS,
    {
      message: `a pause ends in the future and at most ${SUCCESSION_PAUSE_MAX_DAYS} days ahead`,
      path: ['until'],
    },
  )
export type SuccessionPauseInput = z.infer<typeof SuccessionPauseInputSchema>

/** The heir is named by person ref, like every other person call (`PersonRefSchema`). */
export const SuccessionSetHeirInputSchema = PersonRefSchema

/** The claim carries no field: the caller's identity, the step-up and the state decide (succession.md, "The claim"). */
export const SuccessionClaimInputSchema = z.object({}).strict()
export type SuccessionClaimInput = z.infer<typeof SuccessionClaimInputSchema>

/** What the owner sees: the heir, the window, the pause and the run. Never a secret. */
export const SuccessionOwnerViewSchema = z.object({
  role: z.literal('owner'),
  state: SuccessionStateSchema,
  heir: z.object({ id: z.string(), name: z.string() }).nullable(),
  windowDays: z.number().int(),
  pausedUntil: z.number().int().nullable(),
  lastSignAt: z.number().int().nullable(),
  runId: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  graceStartedAt: z.number().int().nullable(),
  claimableAt: z.number().int().nullable(),
})
export type SuccessionOwnerView = z.infer<typeof SuccessionOwnerViewSchema>

/**
 * What the heir sees: the state, the claim date and the moment the claim opens (succession.md, "RPC"). `claimOpensAt` is
 * the grace's end in `grace` and `claimableAt` in `claimable`, null otherwise. Nothing else: no owner's sign, no presence.
 */
export const SuccessionHeirViewSchema = z.object({
  role: z.literal('heir'),
  state: SuccessionStateSchema,
  claimableAt: z.number().int().nullable(),
  claimOpensAt: z.number().int().nullable(),
})
export type SuccessionHeirView = z.infer<typeof SuccessionHeirViewSchema>

export const SuccessionViewSchema = z.discriminatedUnion('role', [
  SuccessionOwnerViewSchema,
  SuccessionHeirViewSchema,
])
export type SuccessionView = z.infer<typeof SuccessionViewSchema>

/** The claim answers with the transfer, as a hand-over does. */
export const SuccessionClaimOutputSchema = OwnerTransferredSchema
