/**
 * The stored sign-in policy (docs/specs/auth.md, "Policy"): the settings key `auth.policy`, with the
 * built-in `DEFAULT_POLICY` as the fallback when nothing is stored or what is stored does not parse.
 * It is read on every use, so a change (or the offline reset) applies to the next request.
 */
import { type AuthPolicy, AuthPolicySchema, type AuthZone } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import { allows, DEFAULT_POLICY } from './policy.ts'
import { isValidCidr } from './zone.ts'

export const POLICY_SETTING = 'auth.policy'

export interface PolicyStore {
  /** The stored policy, or the default (nothing stored, or the stored value is invalid: a warning is logged). */
  get(): AuthPolicy
  isDefault(): boolean
  set(policy: AuthPolicy): void
  /** Forget the stored policy: the default applies again. */
  reset(): void
}

export function createPolicyStore(
  settings: SettingsRepo,
  warn: (message: string) => void = () => {},
): PolicyStore {
  let warned = false
  const stored = (): AuthPolicy | undefined => {
    let raw: unknown
    try {
      raw = settings.get<unknown>(POLICY_SETTING)
    } catch {
      raw = null
    }
    if (raw === undefined) return undefined
    const parsed = AuthPolicySchema.safeParse(raw)
    if (parsed.success) return parsed.data
    if (!warned) {
      warned = true
      warn(
        'the stored auth policy is invalid: the default policy applies (fix it or run `keith-core auth policy reset`)',
      )
    }
    return undefined
  }
  return {
    get: () => stored() ?? DEFAULT_POLICY,
    isDefault: () => stored() === undefined,
    set(policy) {
      settings.set(POLICY_SETTING, policy)
      warned = false
    },
    reset() {
      settings.delete(POLICY_SETTING)
      warned = false
    },
  }
}

/** The sign-in methods a person types: if none admits the owner from a zone, the owner cannot sign in there. */
const OWNER_METHODS = ['password', 'pin'] as const

/**
 * The lockout guard: why this policy may not be stored, or undefined. Every CIDR must parse, and from
 * each of `zones` (the owner's usual ways in: `loopback`, plus the zone of the caller) the owner must keep
 * a password or PIN sign-in. An owner who still reaches the machine has the socket and `keith-core auth
 * policy reset`; this guard is for the owner who changes it from afar.
 */
export function policyProblem(policy: AuthPolicy, zones: readonly AuthZone[]): string | undefined {
  const bad = [...policy.lanCidrs, ...policy.rules.flatMap((r) => r.cidrs)].find(
    (c) => !isValidCidr(c),
  )
  if (bad !== undefined) return `"${bad.slice(0, 64)}" is not a valid CIDR (address/length)`
  for (const zone of zones) {
    const reachable = OWNER_METHODS.some((method) =>
      allows(policy, method, { zone, role: 'owner', identifierKind: 'username' }),
    )
    if (!reachable) {
      return `refused: the owner would keep no password or PIN sign-in from ${zone}`
    }
  }
  return undefined
}
