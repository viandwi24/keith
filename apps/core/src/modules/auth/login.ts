/**
 * `POST /auth/login` and `POST /auth/step-up` (docs/specs/auth.md): the password routes. Both obey
 * the network rule, the 4 KB body cap, per-(account, address) throttling and uniform answers.
 */
import {
  type AccessProxy,
  AuthMethodIdSchema,
  type AuthMethods,
  type AuthPolicy,
  LoginRequestSchema,
  StepUpRequestSchema,
} from '@keith/contracts'
import type { CredentialsRepo, IdentifiersRepo, SecretsRepo, TokensRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { formatCredential, hashSecret, newCredentialId, newSecret } from './credentials.ts'
import { createFlowRoutes } from './flow.ts'
import { type Hasher, HasherBusyError } from './hasher.ts'
import { AUTH_BODY_MAX, answer, readJson } from './http.ts'
import { candidatesOf } from './identifier.ts'
import { deviceMethod } from './methods/device.ts'
import { createPasswordMethod, DEFAULT_LOGIN_LABEL } from './methods/password.ts'
import { createPinMethod } from './methods/pin.ts'
import { createAuthRegistry } from './methods/registry.ts'
import { tokenMethod } from './methods/token.ts'
import { methodDecision } from './network-rule.ts'
import type { Peer } from './peer.ts'
import { DEFAULT_POLICY } from './policy.ts'
import { sessionTerms } from './session-terms.ts'
import { createThrottle } from './throttle.ts'
import type { Principal } from './tokens.ts'
import { createWebRoutes } from './web-routes.ts'
import { createCookieIssuer, withSetCookie } from './web-session.ts'
import type { LanNets } from './zone.ts'

/** A step-up lasts this long from the moment the PIN or password is confirmed (fixed, not sliding). */
export const STEP_UP_MS = 10 * 60_000
/** After a rotation the old credential keeps working this long, so a request in flight is not cut off. */
export const ROTATE_GRACE_MS = 60_000

export type { Peer }
export { DEFAULT_LOGIN_LABEL }

export interface AuthRoutesOptions {
  secrets: SecretsRepo
  credentials: CredentialsRepo
  /** Legacy tokens: `POST /auth/web/adopt` can turn one into the cookie. */
  tokens?: TokensRepo
  hasher: Hasher
  audit: Audit
  /** `access.proxy`, read per request (a setting). */
  proxy: () => AccessProxy
  /** `KEITH_INSECURE_LOGIN=true`. */
  insecure: boolean
  /** User ids, usernames, emails and phones for the identifier-first flow. */
  identifiers: IdentifiersRepo
  /** The sign-in policy, read per request (the stored one, else the default). */
  policy?: () => AuthPolicy
  /** The on-link subnets (`lan` zone), read per request; none means no LAN zone. */
  lan?: () => LanNets | undefined
  now?: () => number
}

export interface AuthRoutes {
  /** `GET /auth/methods`: which login methods this caller's address may use (no audit, no account data). */
  methods(request: Request, peer: Peer): Response
  login(request: Request, peer: Peer): Promise<Response>
  /** `POST /auth/identify`: the identifier-first flow's first call (docs/specs/auth.md). */
  identify(request: Request, peer: Peer): Promise<Response>
  /** `POST /auth/flow/:id`: the answer to the current step. */
  flow(request: Request, peer: Peer, flowId: string): Promise<Response>
  /** `principal` is the one the thalamus middleware resolved for this request (or undefined). */
  stepUp(request: Request, peer: Peer, principal: Principal | undefined): Promise<Response>
  /** `POST /auth/web/adopt`: a credential in the body becomes the session cookie (docs/specs/auth.md, "Browser sessions"). */
  webAdopt(request: Request, peer: Peer): Promise<Response>
  /** `POST /auth/web/logout`: revoke the session behind the call and clear the cookie. */
  webLogout(request: Request, peer: Peer, principal: Principal | undefined): Promise<Response>
}

const INVALID = (): Response => answer(401, { error: 'invalid_credentials' })
const UNAVAILABLE = (): Response => answer(503, { error: 'unavailable' })
const BAD = (): Response => answer(400, { error: 'bad_request' })

export function createAuthRoutes(options: AuthRoutesOptions): AuthRoutes {
  const now = options.now ?? Date.now
  const throttle = createThrottle(options.secrets, now)
  const { secrets, hasher, audit } = options
  const policy = options.policy ?? (() => DEFAULT_POLICY)
  const secretOptions = {
    secrets,
    credentials: options.credentials,
    hasher,
    throttle,
    audit,
  }
  const password = createPasswordMethod(secretOptions)
  // `pin` is not in the legacy methods list (`AuthMethodIdSchema`): only the flow offers it
  const registry = createAuthRegistry([
    deviceMethod,
    createPinMethod(secretOptions),
    password,
    tokenMethod,
  ])
  const cookies = createCookieIssuer(options.credentials, now)
  const web = createWebRoutes({
    credentials: options.credentials,
    tokens: options.tokens,
    audit,
    cookies,
    now,
  })
  const flows = createFlowRoutes({
    cookies,
    registry,
    identifiers: options.identifiers,
    audit,
    policy,
    proxy: options.proxy,
    insecure: options.insecure,
    lan: options.lan,
    now,
  })

  const lanOf = (): { lan?: LanNets } => {
    const lan = options.lan?.()
    return lan === undefined ? {} : { lan }
  }

  /** The refusal of the network rule (and its audit trail), or the tailscale user to log. */
  const gate = (
    request: Request,
    peer: Peer,
    kind: string,
    method: 'password' | 'pin' = 'password',
  ): { refused: Response } | { tailscaleUser?: string } => {
    const decision = methodDecision(policy(), method, {
      via: peer.via,
      ip: peer.ip,
      forwarded: peer.forwarded,
      headers: request.headers,
      proxy: options.proxy(),
      insecure: options.insecure,
      ...lanOf(),
    })
    if (decision.allowed)
      return decision.tailscaleUser === undefined ? {} : { tailscaleUser: decision.tailscaleUser }
    audit.record({
      kind: `${kind}.refused`,
      actor: 'system',
      via: peer.via,
      detail: { reason: decision.reason, ip: peer.ip, forwarded: peer.forwarded },
    })
    return { refused: answer(403, { error: 'login_not_allowed_here' }) }
  }
  const trail = (peer: Peer, tailscaleUser: string | undefined): Record<string, unknown> => ({
    ip: peer.ip,
    ...(peer.forwarded ? { forwarded: true } : {}),
    ...(tailscaleUser === undefined ? {} : { tailscaleUser }),
  })

  return {
    methods(request, peer) {
      const input = {
        via: peer.via,
        ip: peer.ip,
        forwarded: peer.forwarded,
        headers: request.headers,
        proxy: options.proxy(),
        insecure: options.insecure,
        ...lanOf(),
      }
      const listed: AuthMethods['methods'] = []
      for (const method of registry.list()) {
        const id = AuthMethodIdSchema.safeParse(method.id)
        if (!id.success) continue
        listed.push(
          methodDecision(policy(), method.id, input).allowed
            ? { id: id.data, available: true }
            : { id: id.data, available: false, reason: method.refusal },
        )
      }
      return new Response(JSON.stringify({ methods: listed } satisfies AuthMethods), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    },

    identify: flows.identify,
    flow: flows.answer,
    webAdopt: web.adopt,
    webLogout: web.logout,

    async login(request, peer) {
      const checked = gate(request, peer, 'auth.login')
      if ('refused' in checked) return checked.refused
      const read = await readJson(request, AUTH_BODY_MAX)
      if (!read.ok) return read.response
      const parsed = LoginRequestSchema.safeParse(read.body)
      if (!parsed.success) return BAD()
      // the same lookup as /auth/flow: role and identifier kind narrow the rule, an unknown name takes the same path
      const found = options.identifiers.lookup(candidatesOf(parsed.data.username))
      const input = {
        via: peer.via,
        ip: peer.ip,
        forwarded: peer.forwarded,
        headers: request.headers,
        proxy: options.proxy(),
        insecure: options.insecure,
        ...lanOf(),
      }
      const who = { role: found?.person.role, identifierKind: found?.kind }
      const permitted = methodDecision(policy(), 'password', input, who).allowed
      const terms = sessionTerms(policy(), 'password', input, who)
      const outcome = await password.verifyFor({
        person: found?.person,
        seed: parsed.data.username.trim().toLowerCase(),
        secret: parsed.data.password,
        label: parsed.data.label,
        permitted,
        via: peer.via,
        ip: peer.ip,
        forwarded: peer.forwarded,
        tailscaleUser: checked.tailscaleUser,
        lifetime: terms.lifetime,
        userAgent: terms.userAgent,
      })
      if (outcome.ok) return answer(200, { credential: outcome.credential })
      if (outcome.status === 429) return answer(429, { error: 'throttled' }, outcome.retryAfter)
      return outcome.status === 503 ? UNAVAILABLE() : INVALID()
    },

    async stepUp(request, peer, principal) {
      if (principal === undefined) {
        const early = gate(request, peer, 'auth.step_up')
        if ('refused' in early) return early.refused
        return answer(401, { error: 'unauthorized' })
      }
      // the socket is the owner at the machine: always stepped up, nothing to store
      if (peer.via === 'local' && principal.credential === undefined)
        return answer(200, { elevatedUntil: now() + STEP_UP_MS })
      const read = await readJson(request, AUTH_BODY_MAX)
      if (!read.ok) return read.response
      const parsed = StepUpRequestSchema.safeParse(read.body)
      if (!parsed.success) return BAD()
      // the zone rule of the method that answers: a PIN follows the PIN rule, a password the password rule
      const checked = gate(request, peer, 'auth.step_up', 'pin' in parsed.data ? 'pin' : 'password')
      if ('refused' in checked) return checked.refused
      const own = principal.credential
      if (own === undefined || own.kind === 'legacy') {
        return answer(409, {
          error: 'legacy_credential',
          hint: 'sign in again (keith login) to get a session that can step up',
        })
      }
      const who = principal.username ?? principal.personId
      const subject = principal.personId
      const wait = throttle.blocked(subject, peer.ip)
      if (wait !== undefined) return answer(429, { error: 'throttled' }, wait)
      if (secrets.kinds(subject).length === 0) {
        return answer(403, {
          error: 'no_step_up_method',
          hint: `keith-core people pin ${who}`,
        })
      }
      const kind = 'pin' in parsed.data ? 'pin' : 'password'
      // a PIN session cannot confirm with the PIN: one factor would start the session and confirm the act
      if (kind === 'pin' && own.methods?.includes('pin') === true && (own.assurance ?? 0) < 2) {
        return answer(403, {
          error: 'pin_session_cannot_step_up',
          hint: 'confirm with your password',
        })
      }
      const given = 'pin' in parsed.data ? parsed.data.pin : parsed.data.password
      const stored = secrets.get(subject, kind)
      let matched: boolean
      try {
        matched = await hasher.verify(given, stored?.hash)
      } catch (error) {
        if (error instanceof HasherBusyError) return UNAVAILABLE()
        throw error
      }
      const detail = {
        personId: subject,
        method: kind,
        credentialId: own.id,
        ...trail(peer, checked.tailscaleUser),
      }
      if (!matched || throttle.locked(subject)) {
        throttle.failed(subject, peer.ip, { known: true, member: principal.role === 'member' })
        audit.record({ kind: 'auth.step_up.failed', actor: subject, via: peer.via, detail })
        return INVALID()
      }
      throttle.succeeded(subject)
      const elevatedUntil = now() + STEP_UP_MS
      if (parsed.data.rotate === true) {
        // a new credential replaces this one (the old keeps working for a short grace)
        const secret = newSecret()
        const id = newCredentialId()
        const assurance = kind === 'password' ? 2 : (own.assurance ?? 0)
        const methods = own.methods ?? [own.kind]
        // a remembered session stays remembered after the rotation
        const remember = cookies.remembered(own.id)
        const rotated = options.credentials.rotate(
          own.id,
          {
            id,
            secretHash: await hashSecret(secret),
            assurance,
            methods:
              kind === 'password' && !methods.includes('password')
                ? [...methods, 'password']
                : methods,
            elevatedUntil,
          },
          ROTATE_GRACE_MS,
        )
        if (!rotated) return INVALID()
        audit.record({
          kind: 'auth.step_up.ok',
          actor: subject,
          via: peer.via,
          detail: { ...detail, elevatedUntil, rotatedTo: id },
        })
        const credential = formatCredential(id, secret)
        if (parsed.data.deliver === 'cookie') {
          return withSetCookie(
            answer(200, { elevatedUntil, cookie: true }),
            cookies.issue(request, credential, remember),
          )
        }
        return answer(200, { elevatedUntil, credential })
      }
      if (!options.credentials.setElevated(own.id, elevatedUntil)) return INVALID()
      audit.record({
        kind: 'auth.step_up.ok',
        actor: subject,
        via: peer.via,
        detail: { ...detail, elevatedUntil },
      })
      return answer(200, { elevatedUntil })
    },
  }
}
