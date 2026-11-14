/**
 * Identifier-first sign-in (docs/specs/auth.md, ADR-0014): `POST /auth/identify` and
 * `POST /auth/flow/:id`. The method list depends on the zone of the peer and the global policy
 * only, so an unknown identifier gets the same answer, the same work and the same limits as a
 * known one (a decoy flow). Person- and role-level narrowing is applied at verify and fails with
 * the uniform 401.
 */
import {
  type AccessProxy,
  type AuthPolicy,
  FlowAnswerSchema,
  type IdentifierKind,
  IdentifyRequestSchema,
  type IdentifyResponse,
  type MethodDescriptor,
} from '@keith/contracts'
import type { IdentifiersRepo, LoginPerson } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import { AUTH_BODY_MAX, answer, readJson } from './http.ts'
import { candidatesOf, identifierKey } from './identifier.ts'
import { createLimiter } from './limiter.ts'
import type { AuthRegistry } from './methods/registry.ts'
import type { AuthMethod } from './methods/types.ts'
import { methodDecision, type NetworkDecision, type NetworkRuleInput } from './network-rule.ts'
import type { Peer } from './peer.ts'
import { sessionTerms } from './session-terms.ts'
import { type LanNets, zoneOf } from './zone.ts'

/** A flow lives this long from `identify`. */
export const FLOW_TTL_MS = 5 * 60_000
/** Wrong answers a flow takes before it is dropped (the durable throttle counts them as well). */
export const FLOW_MAX_FAILURES = 5
const MAX_FLOWS = 2000
const MAX_FLOWS_PER_IP = 20
/** Methods tried first when the core marks the default, in order. */
const DEFAULT_ORDER = ['pin', 'password']

interface Flow {
  ip: string
  expiresAt: number
  failures: number
  /** The resolved person, or undefined for a decoy. */
  person: LoginPerson | undefined
  kind: IdentifierKind | undefined
  /** The normalised identifier: the counter key of a decoy. */
  seed: string
}

export interface FlowRoutesOptions {
  registry: AuthRegistry
  identifiers: IdentifiersRepo
  audit: Audit
  policy: () => AuthPolicy
  proxy: () => AccessProxy
  insecure: boolean
  lan?: (() => LanNets | undefined) | undefined
  now: () => number
}

export interface FlowRoutes {
  identify(request: Request, peer: Peer): Promise<Response>
  answer(request: Request, peer: Peer, flowId: string): Promise<Response>
}

const FLOW_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const BAD = (): Response => answer(400, { error: 'bad_request' })
const NOT_FOUND = (): Response => answer(404, { error: 'not_found' })
const INVALID = (): Response => answer(401, { error: 'invalid_credentials' })
const THROTTLED = (retryAfter: number): Response => answer(429, { error: 'throttled' }, retryAfter)

export function createFlowRoutes(options: FlowRoutesOptions): FlowRoutes {
  const { registry, identifiers, audit, now } = options
  const flows = new Map<string, Flow>()
  // per address, then per (identifier, address); every call counts, known or not
  const perIp = createLimiter({ limit: 60, windowMs: 5 * 60_000, now })
  const perIdentifier = createLimiter({ limit: 10, windowMs: 5 * 60_000, now })
  const answers = createLimiter({ limit: 60, windowMs: 5 * 60_000, now })

  const lanOf = (): { lan?: LanNets } => {
    const lan = options.lan?.()
    return lan === undefined ? {} : { lan }
  }
  const inputOf = (request: Request, peer: Peer): NetworkRuleInput => ({
    via: peer.via,
    ip: peer.ip,
    forwarded: peer.forwarded,
    headers: request.headers,
    proxy: options.proxy(),
    insecure: options.insecure,
    ...lanOf(),
  })

  const prune = (): void => {
    const at = now()
    for (const [id, flow] of flows) if (flow.expiresAt <= at) flows.delete(id)
    while (flows.size >= MAX_FLOWS) {
      const oldest = flows.keys().next().value
      if (oldest === undefined) break
      flows.delete(oldest)
    }
  }

  const store = (peer: Peer, flow: Omit<Flow, 'ip' | 'expiresAt' | 'failures'>): string => {
    prune()
    const mine = [...flows].filter(([, f]) => f.ip === peer.ip)
    for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_FLOWS_PER_IP + 1))) {
      flows.delete(id)
    }
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')
    flows.set(id, { ...flow, ip: peer.ip, expiresAt: now() + FLOW_TTL_MS, failures: 0 })
    return id
  }

  /** The policy decision, plus the methods that are never offered from the public zone (the PIN). */
  const decide = (
    method: AuthMethod,
    input: NetworkRuleInput,
    who: Parameters<typeof methodDecision>[3] = {},
  ): NetworkDecision => {
    if (method.neverPublic === true && input.via !== 'local') {
      const found = zoneOf(input)
      if (found.zone === 'public') return { allowed: false, reason: found.hint ?? 'network' }
    }
    return methodDecision(options.policy(), method.id, input, who)
  }

  const describe = (method: AuthMethod, input: NetworkRuleInput): MethodDescriptor => {
    const decision = decide(method, input)
    return {
      id: method.id,
      label: method.label,
      available: decision.allowed,
      ...(decision.allowed ? {} : { reason: method.refusal }),
      assurance: method.assurance,
      firstStep: method.flowStep ?? method.firstStep,
      interaction: method.interaction,
    }
  }

  return {
    async identify(request, peer) {
      const read = await readJson(request, AUTH_BODY_MAX)
      if (!read.ok) return read.response
      const parsed = IdentifyRequestSchema.safeParse(read.body)
      if (!parsed.success) return BAD()
      const identifier = parsed.data.identifier
      const wait =
        perIp.take(`ip:${peer.ip}`) ?? perIdentifier.take(`${identifierKey(identifier)}:${peer.ip}`)
      if (wait !== undefined) return THROTTLED(wait)
      // the same four queries for any identifier
      const found = identifiers.lookup(candidatesOf(identifier))
      const input = inputOf(request, peer)
      const methods = registry.list().map((m) => describe(m, input))
      const first = DEFAULT_ORDER.map((id) => methods.find((m) => m.id === id && m.available)).find(
        (m) => m !== undefined,
      )
      const flowId = store(peer, {
        person: found?.person,
        kind: found?.kind,
        seed: identifier.trim().toLowerCase(),
      })
      const body: IdentifyResponse = {
        flowId,
        context: peer.via === 'local' ? 'loopback' : zoneOf(input).zone,
        methods: methods.map((m) => (m === first ? { ...m, default: true } : m)),
      }
      return answer(200, body)
    },

    async answer(request, peer, flowId) {
      const read = await readJson(request, AUTH_BODY_MAX)
      if (!read.ok) return read.response
      const parsed = FlowAnswerSchema.safeParse(read.body)
      if (!parsed.success) return BAD()
      const wait = answers.take(`ip:${peer.ip}`)
      if (wait !== undefined) return THROTTLED(wait)
      const flow = FLOW_ID_RE.test(flowId) ? flows.get(flowId) : undefined
      if (flow === undefined || flow.expiresAt <= now() || flow.ip !== peer.ip) {
        if (flow !== undefined && flow.expiresAt <= now()) flows.delete(flowId)
        return NOT_FOUND()
      }
      const method = registry.get(parsed.data.method)
      if (method?.verifyFor === undefined) return BAD()
      const input = inputOf(request, peer)
      const zoned = decide(method, input)
      if (!zoned.allowed) {
        audit.record({
          kind: 'auth.login.refused',
          actor: 'system',
          via: peer.via,
          detail: { reason: zoned.reason, ip: peer.ip, forwarded: peer.forwarded, flow: true },
        })
        return answer(403, { error: 'login_not_allowed_here' })
      }
      const field = (method.flowStep ?? method.firstStep).fields[0]?.name
      const given = field === undefined ? undefined : parsed.data.answer[field]
      if (given === undefined) return BAD()
      // role and identifier kind narrow the rule here, never in the list
      const permitted = decide(method, input, {
        role: flow.person?.role,
        identifierKind: flow.kind,
      }).allowed
      const terms = sessionTerms(
        options.policy(),
        method.id,
        input,
        { role: flow.person?.role, identifierKind: flow.kind },
        parsed.data.remember === true,
      )
      const outcome = await method.verifyFor({
        person: flow.person,
        seed: flow.seed,
        secret: given,
        zone: input.via === 'local' ? 'loopback' : zoneOf(input).zone,
        label: parsed.data.answer.label,
        permitted,
        via: peer.via,
        ip: peer.ip,
        forwarded: peer.forwarded,
        tailscaleUser: zoned.tailscaleUser,
        lifetime: terms.lifetime,
        userAgent: terms.userAgent,
      })
      if (outcome.ok) {
        flows.delete(flowId)
        return answer(200, { credential: outcome.credential })
      }
      if (outcome.status === 429) return THROTTLED(outcome.retryAfter)
      if (outcome.status === 503) return answer(503, { error: 'unavailable' })
      flow.failures += 1
      if (flow.failures >= FLOW_MAX_FAILURES) flows.delete(flowId)
      return INVALID()
    },
  }
}
