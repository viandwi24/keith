/** `POST /auth/web/adopt` and `POST /auth/web/logout` (docs/specs/auth.md, "Browser sessions"). */
import { WebAdoptRequestSchema } from '@keith/contracts'
import type { CredentialsRepo, TokensRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { parseCredential, verifyCredential } from './credentials.ts'
import { AUTH_BODY_MAX, answer, readJson } from './http.ts'
import { createLimiter } from './limiter.ts'
import type { Peer } from './peer.ts'
import type { Principal } from './tokens.ts'
import { verifyAuthorization } from './tokens.ts'
import {
  type CookieIssuer,
  clearCookieValue,
  isSecureRequest,
  withSetCookie,
} from './web-session.ts'

export interface WebRoutes {
  /** The credential in the body becomes the session cookie (a pasted token). */
  adopt(request: Request, peer: Peer): Promise<Response>
  /** Revoke the session behind the call and clear the cookie. `principal` is the one the middleware resolved. */
  logout(request: Request, peer: Peer, principal: Principal | undefined): Promise<Response>
}

export interface WebRoutesOptions {
  credentials: CredentialsRepo
  /** Legacy `keith_<b64>` tokens; without it only session credentials are adopted. */
  tokens?: TokensRepo | undefined
  audit: Audit
  cookies: CookieIssuer
  now: () => number
}

export function createWebRoutes(options: WebRoutesOptions): WebRoutes {
  const { credentials, tokens, audit, cookies, now } = options
  // the same budget as the answers of `/auth/flow`: every call counts, valid or not
  const limiter = createLimiter({ limit: 60, windowMs: 5 * 60_000, now })
  return {
    async adopt(request, peer) {
      const read = await readJson(request, AUTH_BODY_MAX)
      if (!read.ok) return read.response
      const parsed = WebAdoptRequestSchema.safeParse(read.body)
      if (!parsed.success) return answer(400, { error: 'bad_request' })
      const wait = limiter.take(`ip:${peer.ip}`)
      if (wait !== undefined) return answer(429, { error: 'throttled' }, wait)
      const given = parsed.data.credential
      let principal: Principal | undefined
      if (parseCredential(given) !== undefined) {
        principal = await verifyCredential(credentials, given, { ip: peer.ip, now })
      } else if (tokens !== undefined) {
        principal = await verifyAuthorization(tokens, `Bearer ${given}`)
      }
      if (principal === undefined) return answer(401, { error: 'invalid_credentials' })
      return withSetCookie(
        answer(200, { cookie: true }),
        cookies.issue(request, given, parsed.data.remember === true),
      )
    },

    async logout(request, peer, principal) {
      const clear = clearCookieValue(isSecureRequest(request))
      const own = principal?.credential
      if (principal !== undefined && own !== undefined) {
        const revoked =
          own.kind === 'legacy'
            ? tokens?.revoke(own.id) === true
            : credentials.revoke(own.id, undefined, 'logout')
        if (revoked) {
          audit.record({
            kind: 'credential.revoked',
            actor: principal.personId,
            via: peer.via,
            detail: {
              credentialId: own.id,
              credentialKind: own.kind,
              subject: principal.personId,
              by: 'logout',
            },
          })
        }
      }
      return withSetCookie(answer(200, { ok: true }), clear)
    },
  }
}
