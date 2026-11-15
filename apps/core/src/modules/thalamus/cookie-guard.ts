/** The cookie rules of the thalamus middleware (docs/specs/auth.md, "Browser sessions"). */
import type { Principal } from '../auth/index.ts'
import {
  clearCookieValue,
  crossSiteWrite,
  isSecureRequest,
  sessionCookieOf,
  withSetCookie,
} from '../auth/index.ts'

/** A 403 for a cookie-authenticated write that is not same-origin (CSRF), else undefined. */
export function csrfRefusal(
  request: Request,
  principal: Principal | undefined,
): Response | undefined {
  if (principal?.viaCookie !== true || !crossSiteWrite(request)) return undefined
  return new Response(
    JSON.stringify({
      error: { code: 'CROSS_SITE', message: 'a cookie session needs a same-origin request' },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

/** Whether a request carried a session cookie (and no `Authorization` header) that did not resolve. */
export const cookieRejected = (request: Request, principal: Principal | undefined): boolean =>
  principal === undefined &&
  !request.headers.has('authorization') &&
  sessionCookieOf(request.headers) !== undefined

/** The response with the cookie cleared. */
export const clearCookie = (request: Request, response: Response): Response =>
  withSetCookie(response, clearCookieValue(isSecureRequest(request)))
