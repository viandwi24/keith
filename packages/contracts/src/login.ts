import { z } from 'zod'

/**
 * Error code of a call that needs a recent step-up (PIN or password). `/rpc` answers with an oRPC
 * error of this `code` (HTTP 403); P9 step 3 raises it from the capability middleware.
 */
export const KEITH_STEP_UP_REQUIRED = 'KEITH_STEP_UP_REQUIRED'

/** Body of `POST /auth/login`. */
export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  label: z.string().trim().min(1).max(80).optional(),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const LoginResponseSchema = z.object({ credential: z.string() })
export type LoginResponse = z.infer<typeof LoginResponseSchema>

/**
 * Body of `POST /auth/step-up`: a PIN or the password, exactly one. `rotate: true` asks for a new
 * credential in the answer (the old one stops working after a short grace); a client that saves it
 * sets the flag, an older one does not and keeps its credential.
 */
export const StepUpRequestSchema = z.union([
  z.object({ pin: z.string().min(1).max(64), rotate: z.boolean().optional() }).strict(),
  z.object({ password: z.string().min(1).max(1024), rotate: z.boolean().optional() }).strict(),
])
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>

export const StepUpResponseSchema = z.object({
  elevatedUntil: z.number(),
  /** The new credential, shown once; only when the request had `rotate: true`. */
  credential: z.string().optional(),
})
export type StepUpResponse = z.infer<typeof StepUpResponseSchema>

/** Error body of the auth routes: `{ error }` plus optional `retryAfter` (seconds) and `hint`. */
export const AuthErrorSchema = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
  hint: z.string().optional(),
})
export type AuthError = z.infer<typeof AuthErrorSchema>

/** The login methods a client may offer. */
export const AuthMethodIdSchema = z.enum(['device', 'password', 'token'])
export type AuthMethodId = z.infer<typeof AuthMethodIdSchema>

/**
 * Answer of `GET /auth/methods`: which methods this core accepts from the caller's address. It holds
 * nothing about accounts; `reason` is a short generic hint, never an address or a setting.
 */
export const AuthMethodsSchema = z.object({
  methods: z
    .array(
      z.object({
        id: AuthMethodIdSchema,
        available: z.boolean(),
        reason: z.string().max(200).optional(),
      }),
    )
    .max(3),
})
export type AuthMethods = z.infer<typeof AuthMethodsSchema>
