import type { CredentialsRepo, TokensRepo } from '@keith/db'
import { parseCredential, verifyCredential } from './credentials.ts'
import { bearerOf, OWNER_ID, type Principal, verifyAuthorization } from './tokens.ts'
import { sessionCookieOf } from './web-session.ts'

/** Where a request came from: the TCP listener, or the owner-only Unix socket. */
export type Via = 'tcp' | 'local'

/** The owner of a first install as the local socket sees them (fallback when no owner row exists). */
export const LOCAL_PRINCIPAL: Principal = { personId: OWNER_ID, role: 'owner', elevated: true }

export interface PrincipalResolver {
  /**
   * The principal of a request, resolved once: later calls with the same `Request` object return
   * the first answer (thalamus asks from its middleware, the `eharness/http` authorize hook and
   * the oRPC handler). `via: 'local'` is owner without a token (unless `localImplicit` says no); everything else needs a bearer:
   * a `keith_s_` credential, or a legacy `keith_<b64>` token. `ip` is the socket's peer address.
   */
  resolve(request: Request, via?: Via, ip?: string): Promise<Principal | undefined>
}

export interface ResolverOptions {
  now?: () => number
  /**
   * Whether the socket serves the implicit owner (default true). With `local trust: none` it is false
   * and a socket request needs a bearer like a TCP one (docs/specs/auth.md, "The local socket").
   */
  localImplicit?: () => boolean
}

export function createPrincipalResolver(
  tokens: TokensRepo,
  credentials: CredentialsRepo,
  options: ResolverOptions = {},
): PrincipalResolver {
  /** The socket is the current owner, whoever holds the role after a transfer. */
  const localOwner = (): Principal => {
    const owner = tokens.owner()
    return owner === undefined
      ? LOCAL_PRINCIPAL
      : {
          personId: owner.id,
          role: 'owner',
          username: owner.username,
          name: owner.name,
          elevated: true,
        }
  }
  const seen = new WeakMap<Request, Promise<Principal | undefined>>()
  const lookup = async (
    request: Request,
    ip: string | undefined,
  ): Promise<Principal | undefined> => {
    const header = request.headers.get('authorization')
    // a bearer always wins; the cookie is read only when the call has no Authorization header at all
    if (header === null) {
      const cookie = sessionCookieOf(request.headers)
      if (cookie === undefined) return undefined
      const found = await verifyToken(cookie, `Bearer ${cookie}`, ip)
      return found === undefined ? undefined : { ...found, viaCookie: true }
    }
    const token = bearerOf(header)
    if (token === undefined) return undefined
    return verifyToken(token, header, ip)
  }
  const verifyToken = async (
    token: string,
    header: string,
    ip: string | undefined,
  ): Promise<Principal | undefined> => {
    if (parseCredential(token) !== undefined) {
      return verifyCredential(credentials, token, {
        ip,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    }
    return verifyAuthorization(tokens, header)
  }
  return {
    resolve(request, via = 'tcp', ip) {
      let found = seen.get(request)
      if (found === undefined) {
        found =
          via === 'local' && (options.localImplicit?.() ?? true)
            ? Promise.resolve(localOwner())
            : lookup(request, ip)
        seen.set(request, found)
      }
      return found
    },
  }
}
