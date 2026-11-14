import type { AuthPolicy, IdentifierKind, PersonRole } from '@keith/contracts'
import type { NetworkRuleInput } from './network-rule.ts'
import { ruleFor } from './policy.ts'
import { zoneOf } from './zone.ts'

/** A user agent is kept for the session list; longer values are cut. */
const USER_AGENT_MAX = 200

/** A session the person asked to keep on this device ("remember this device"): 30 days idle, 180 in all. */
export const REMEMBER_IDLE_MS = 30 * 86_400_000
export const REMEMBER_ABSOLUTE_MS = 180 * 86_400_000

/** Who signs in: the rule that admits this role and identifier kind decides the lifetime. */
export interface SessionWho {
  role?: PersonRole | undefined
  identifierKind?: IdentifierKind | undefined
}

/** A sign-in that is not remembered never outlives a working day: the PIN rule's numbers cap it. */
export const TRANSIENT_IDLE_MS = 12 * 3_600_000
export const TRANSIENT_ABSOLUTE_MS = 7 * 86_400_000

const capped = (ruleMs: number | undefined, capMs: number): number =>
  ruleMs === undefined || ruleMs === 0 ? capMs : Math.min(ruleMs, capMs)

export interface SessionTerms {
  lifetime: { idleMs: number; absoluteMs: number }
  userAgent: string | undefined
}

/**
 * How long a new session of `method` lasts from where this request came from: the idle and
 * absolute lifetimes of the rule that admits it (0 = no limit, the rule of a method without one).
 * A sign-in that is not `remember`ed is capped at 12 h idle and 7 days in all whatever the rule says (FD10-09). `remember` (the person kept this device) replaces them with the remembered-device lifetime. Applies to new sessions only: a policy change never shortens a session that already exists.
 */
export function sessionTerms(
  policy: AuthPolicy,
  method: string,
  input: NetworkRuleInput,
  who: SessionWho = {},
  remember = false,
): SessionTerms {
  const zone = input.via === 'local' ? 'loopback' : zoneOf(input).zone
  const rule = ruleFor(policy, method, {
    zone,
    ip: input.ip,
    role: who.role,
    identifierKind: who.identifierKind,
  })
  const agent = input.headers.get('user-agent')?.trim()
  return {
    lifetime: remember
      ? { idleMs: REMEMBER_IDLE_MS, absoluteMs: REMEMBER_ABSOLUTE_MS }
      : {
          idleMs: capped(rule?.idleMs, TRANSIENT_IDLE_MS),
          absoluteMs: capped(rule?.absoluteMs, TRANSIENT_ABSOLUTE_MS),
        },
    userAgent: agent === undefined || agent === '' ? undefined : agent.slice(0, USER_AGENT_MAX),
  }
}
