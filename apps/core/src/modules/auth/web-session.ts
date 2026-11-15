/**
 * Browser sessions (docs/specs/auth.md, "Browser sessions"; ADR-0035): the `keith_s` cookie that carries a session
 * credential for the web client. The helpers here are pure; the routes are in `web-routes.ts`.
 */
import { SESSION_COOKIE } from '@keith/contracts'
import type { CredentialsRepo } from '@keith/db'
import { parseCredential } from './credentials.ts'
import { REMEMBER_ABSOLUTE_MS, TRANSIENT_ABSOLUTE_MS } from './session-terms.ts'

/** The value of the session cookie in a `Cookie` header, or undefined. */
export function sessionCookieOf(headers: Headers): string | undefined {
  const header = headers.get('cookie')
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return raw === '' ? undefined : decodeURIComponent(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Whether the request came over HTTPS: its own URL, or a proxy in front that says so. */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (proto === 'https') return true
  return /(?:^|[;,\s])proto=https\b/i.test(request.headers.get('forwarded') ?? '')
}

/** The `Set-Cookie` value that stores `credential`; `maxAgeSeconds` makes it survive a browser restart. */
export function setCookieValue(
  credential: string,
  options: { secure: boolean; maxAgeSeconds?: number | undefined },
): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(credential)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    ...(options.secure ? ['Secure'] : []),
    ...(options.maxAgeSeconds === undefined ? [] : [`Max-Age=${options.maxAgeSeconds}`]),
  ].join('; ')
}

/** The `Set-Cookie` value that removes the cookie. */
export function clearCookieValue(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    ...(secure ? ['Secure'] : []),
    'Max-Age=0',
  ].join('; ')
}

/** A copy of `response` with one more `Set-Cookie` header (a `fetch` response has immutable headers). */
export function withSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers)
  headers.append('set-cookie', cookie)
  return new Response(response.body, { status: response.status, headers })
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF rule for a cookie-authenticated request: a write needs a same-origin `Origin` (its host is the request's `Host`)
 * or `Sec-Fetch-Site: same-origin`. Reads pass. A bearer request never reaches this check.
 */
export function crossSiteWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false
  const site = request.headers.get('sec-fetch-site')
  if (site === 'same-origin') return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase()
    return new URL(origin).host.toLowerCase() !== host
  } catch {
    return true
  }
}

/** Whether an upgrade request that authenticates with the cookie is same-origin (an `Origin` that names the `Host`). */
export function sameOriginUpgrade(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  try {
    const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase()
    return new URL(origin).host.toLowerCase() === host
  } catch {
    return false
  }
}

export interface CookieIssuer {
  /**
   * The `Set-Cookie` value for a freshly issued credential. `remember` gives a persistent cookie that ends with the
   * session's absolute expiry; otherwise it is a browser-session cookie (no `Max-Age`).
   */
  issue(request: Request, credential: string, remember: boolean): string
  /** Whether the session behind `credentialId` was kept on this device (a lifetime beyond a working week). */
  remembered(credentialId: string): boolean
}

export function createCookieIssuer(
  credentials: CredentialsRepo,
  now: () => number = Date.now,
): CookieIssuer {
  return {
    issue(request, credential, remember) {
      let maxAgeSeconds: number | undefined
      if (remember) {
        const id = parseCredential(credential)?.id
        const end = id === undefined ? null : (credentials.find(id)?.absoluteExpiresAt ?? null)
        // a token has no end of its own: the remembered-device lifetime caps the cookie
        const ms = end === null ? REMEMBER_ABSOLUTE_MS : end - now()
        maxAgeSeconds = Math.max(0, Math.floor(ms / 1000))
      }
      return setCookieValue(credential, { secure: isSecureRequest(request), maxAgeSeconds })
    },
    remembered(credentialId) {
      const end = credentials.find(credentialId)?.absoluteExpiresAt ?? null
      return end !== null && end - now() > TRANSIENT_ABSOLUTE_MS
    },
  }
}
