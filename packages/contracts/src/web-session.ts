import { z } from 'zod'

/**
 * Browser sessions (ADR-0035, docs/specs/auth.md "Browser sessions"). A browser never holds its credential: the core sets it in an
 * HttpOnly cookie when a sign-in asks for `deliver: 'cookie'`, and reads the cookie only when a call has no `Authorization` header.
 */

/** Name of the session cookie. */
export const SESSION_COOKIE = 'keith_s'

/** Where a new credential goes: in the answer body (CLI, TUI, nodes) or in the session cookie (the web client). */
export const CredentialDeliverySchema = z.enum(['body', 'cookie'])
export type CredentialDelivery = z.infer<typeof CredentialDeliverySchema>

/** Body of `POST /auth/web/adopt`: turn a pasted credential (a token) into the session cookie. */
export const WebAdoptRequestSchema = z
  .object({
    credential: z.string().min(1).max(512),
    /** Keep the cookie across browser restarts until the session's absolute expiry; absent or false makes a browser-session cookie. */
    remember: z.boolean().optional(),
  })
  .strict()
export type WebAdoptRequest = z.infer<typeof WebAdoptRequestSchema>

/** Answer of a sign-in whose credential went into the cookie: nothing secret in the body. */
export const CookieIssuedSchema = z.object({ cookie: z.literal(true) })
export type CookieIssued = z.infer<typeof CookieIssuedSchema>
