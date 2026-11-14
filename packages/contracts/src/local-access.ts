import { z } from 'zod'

/**
 * The local socket's access (ADR-0014 decision 9, docs/specs/auth.md, "The local socket"): what
 * `admin.auth.local.get|set` show and change.
 *
 * - `none` (default, ADR-0014 amendment of 2026-11-09): the socket serves no implicit owner; every client
 *   signs in like on TCP, so a visitor at the owner's machine is never silently the owner.
 * - `idle-lock`: the implicit owner, with the idle-lock of P14 step 11 (opt in).
 * - `full`: the implicit owner, never locked by idleness (the behaviour before P14; opt in with a warning).
 */
export const LocalTrustSchema = z.enum(['none', 'idle-lock', 'full'])
export type LocalTrust = z.infer<typeof LocalTrustSchema>

export const IDLE_MINUTES_MAX = 1440
export const DEFAULT_IDLE_MINUTES = 15
export const DEFAULT_LOCAL_TRUST: LocalTrust = 'none'

export const LocalAccessViewSchema = z.object({
  /** The person this trust level belongs to (the socket only ever serves the current owner). */
  personId: z.string(),
  trust: LocalTrustSchema,
  /** Idle minutes before the socket locks; 0 = never. */
  idleMinutes: z.number().int().min(0).max(IDLE_MINUTES_MAX),
  /** The person has a PIN, so the lock can work (without one it is disabled, never a lockout). */
  hasPin: z.boolean(),
  /** The socket answers `423 locked` right now. */
  locked: z.boolean(),
})
export type LocalAccessView = z.infer<typeof LocalAccessViewSchema>

export const LocalAccessGetSchema = z.object({ person: z.string().min(1).max(100).optional() })

export const LocalAccessSetSchema = z
  .object({
    /** Whose trust level (a username or id); default the caller. Idle minutes are global. */
    person: z.string().min(1).max(100).optional(),
    trust: LocalTrustSchema.optional(),
    idleMinutes: z.number().int().min(0).max(IDLE_MINUTES_MAX).optional(),
    /** Required for `full`: the owner has read that a visitor at the keyboard is the owner. */
    acknowledge: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.trust !== undefined || v.idleMinutes !== undefined, {
    message: 'give a trust level or idleMinutes',
  })
export type LocalAccessSet = z.infer<typeof LocalAccessSetSchema>

/** `GET /auth/local/status` answer (socket only): whether the first-owner flow is open. */
export const LocalStatusSchema = z.object({
  /** The owner has no PIN and no password: `POST /auth/local/first-owner` may set the first one (once). */
  needsFirstOwner: z.boolean(),
})
export type LocalStatus = z.infer<typeof LocalStatusSchema>

/** `POST /auth/local/session` answer: a short admin session for `keith-core` (trust `none`). */
export const LocalSessionSchema = z.object({
  credential: z.string(),
  /** When the step-up of this session ends (epoch ms). */
  elevatedUntil: z.number(),
})
export type LocalSession = z.infer<typeof LocalSessionSchema>
