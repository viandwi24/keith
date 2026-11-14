import type { AccessProxy, AuthPolicyView, AuthZone } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { isTailscaleIp, type PolicyStore, policyProblem } from '../auth/index.ts'

/**
 * `admin.auth.policy.get|set` (docs/specs/auth.md, "Policy"). Owner only: a member who was granted
 * `settings.manage` is refused here. `set` needs a step-up over TCP, is audited (`auth.policy.set`)
 * and passes the lockout guard first.
 */
export function authPolicyProcedures(options: { policies: PolicyStore; proxy: () => AccessProxy }) {
  const { policies } = options
  const view = (): AuthPolicyView => ({ policy: policies.get(), isDefault: policies.isDefault() })
  const ownerOnly = (context: RpcContext): void => {
    if (context.principal.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', { message: 'only the owner may read or change the policy' })
    }
  }
  /** The owner's usual ways in: the machine itself, and the tailnet when that is how they arrive. */
  const usualZones = (context: RpcContext): AuthZone[] => {
    const viaTailnet =
      options.proxy() === 'tailscale-serve' || (context.via === 'tcp' && isTailscaleIp(context.ip))
    return viaTailnet ? ['loopback', 'tailscale'] : ['loopback']
  }
  return {
    get: rpc.admin.auth.policy.get.handler(({ context }) => {
      ownerOnly(context)
      return view()
    }),
    set: rpc.admin.auth.policy.set.handler(({ input, context }) => {
      ownerOnly(context)
      const problem = policyProblem(input, usualZones(context))
      if (problem !== undefined) throw new ORPCError('BAD_REQUEST', { message: problem })
      const wasDefault = policies.isDefault()
      policies.set(input)
      context.record('auth.policy.set', {
        rules: input.rules.length,
        methods: [...new Set(input.rules.map((r) => r.method))],
        lanCidrs: input.lanCidrs.length,
        wasDefault,
      })
      return view()
    }),
  }
}
