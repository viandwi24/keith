import type { AccessProxy, AuthPolicy, IdentifierKind, PersonRole } from '@keith/contracts'
import { allows, DEFAULT_POLICY } from './policy.ts'
import type { Via } from './principal.ts'
import { type LanNets, zoneOf } from './zone.ts'

export { isLoopbackIp, isTailscaleIp } from './zone.ts'

export interface NetworkRuleInput {
  via: Via
  /** The TCP peer, never a forwarding header. */
  ip: string | undefined
  /** The request carried proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-*`). */
  forwarded: boolean
  headers: Headers
  /** `access.proxy` of the settings. */
  proxy: AccessProxy
  /** `KEITH_INSECURE_LOGIN=true`. */
  insecure: boolean
  /** The on-link subnets (`lan` zone); none means no LAN zone. */
  lan?: LanNets
}

export type NetworkDecision =
  | { allowed: true; tailscaleUser?: string }
  | { allowed: false; reason: 'funnel' | 'proxy' | 'network' }

/** One method on the policy: `local` and `insecure` short-circuit, otherwise the zone of the peer decides. */
export function methodDecision(
  policy: AuthPolicy,
  method: string,
  input: NetworkRuleInput,
  /** Known at verify only: the role and how the identifier was written narrow the rule. */
  who: { role?: PersonRole | undefined; identifierKind?: IdentifierKind | undefined } = {},
): NetworkDecision {
  if (input.via === 'local') return { allowed: true }
  if (input.insecure) return { allowed: true }
  const found = zoneOf(input)
  if (!allows(policy, method, { zone: found.zone, ip: input.ip, ...who })) {
    return { allowed: false, reason: found.hint ?? 'network' }
  }
  return found.tailscaleUser === undefined
    ? { allowed: true }
    : { allowed: true, tailscaleUser: found.tailscaleUser }
}

/**
 * Where password routes (`/auth/login`, `/auth/step-up`) may be reached from: the local socket,
 * a loopback peer without forwarding headers, a Tailscale address, or `tailscale serve` (loopback
 * peer with forwarding headers) when `access.proxy` says it is configured. Funnel (public) and any
 * other proxy are refused unless `KEITH_INSECURE_LOGIN` is set. `X-Forwarded-For` is never the address.
 */
export const networkRule = (input: NetworkRuleInput): NetworkDecision =>
  methodDecision(DEFAULT_POLICY, 'password', input)
