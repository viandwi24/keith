/**
 * The policy engine (docs/specs/auth.md): data that says which method is allowed from which zone.
 * Evaluated when methods are listed and again at verify. `DEFAULT_POLICY` reproduces the network
 * rule of ADR-0009 exactly: the password from `loopback` and `tailscale`; device code and token
 * from every zone.
 */
import {
  type AuthPolicy,
  AuthPolicySchema,
  type AuthRule,
  type AuthZone,
  type IdentifierKind,
  type PersonRole,
} from '@keith/contracts'
import { inCidrs } from './zone.ts'

/** Default lifetimes of a new password session: 30 days idle, 180 days in all. */
export const PASSWORD_IDLE_MS = 30 * 86_400_000
export const PASSWORD_ABSOLUTE_MS = 180 * 86_400_000

/** Default lifetimes of a new PIN session: 12 hours idle, 7 days in all. */
export const PIN_IDLE_MS = 12 * 3_600_000
export const PIN_ABSOLUTE_MS = 7 * 86_400_000

export const DEFAULT_POLICY: AuthPolicy = AuthPolicySchema.parse({
  rules: [
    {
      method: 'pin',
      zones: ['loopback', 'lan', 'tailscale'],
      idleMs: PIN_IDLE_MS,
      absoluteMs: PIN_ABSOLUTE_MS,
    },
    { method: 'device', zones: ['loopback', 'lan', 'tailscale', 'public'] },
    {
      method: 'password',
      zones: ['loopback', 'tailscale'],
      idleMs: PASSWORD_IDLE_MS,
      absoluteMs: PASSWORD_ABSOLUTE_MS,
    },
    { method: 'token', zones: ['loopback', 'lan', 'tailscale', 'public'] },
  ],
})

export interface PolicyContext {
  zone: AuthZone
  /** The TCP peer, for a rule's `cidrs`. */
  ip?: string | undefined
  /** Known at verify only: a listing passes none and skips the restriction. */
  role?: PersonRole | undefined
  identifierKind?: IdentifierKind | undefined
}

const admits = (rule: AuthRule, ctx: PolicyContext): boolean => {
  const where = rule.zones.includes(ctx.zone) || inCidrs(ctx.ip, rule.cidrs)
  if (!where) return false
  if (ctx.role !== undefined && rule.roles !== undefined && !rule.roles.includes(ctx.role)) {
    return false
  }
  return !(
    ctx.identifierKind !== undefined &&
    rule.identifierKinds !== undefined &&
    !rule.identifierKinds.includes(ctx.identifierKind)
  )
}

/** The first rule of the method that admits this context, or undefined (the method is not offered). */
export function ruleFor(
  policy: AuthPolicy,
  method: string,
  ctx: PolicyContext,
): AuthRule | undefined {
  return policy.rules.find((r) => r.method === method && admits(r, ctx))
}

export const allows = (policy: AuthPolicy, method: string, ctx: PolicyContext): boolean =>
  ruleFor(policy, method, ctx) !== undefined
