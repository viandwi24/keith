import type { AuthPolicy } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { type LocalAccess, type PolicyStore, policyProblem } from '../auth/index.ts'
import type { PeopleService } from '../people/index.ts'

/**
 * Why trust level `none` may not be set for a person, or undefined: the socket then serves nobody
 * without a session, so the person needs a PIN or password and the policy must admit one from the
 * `loopback`. The RPC and the offline `keith-core auth local set` share this guard. The socket itself
 * never reads the policy; the guard protects the TCP sign-in the owner would be locked out of.
 */
export function trustNoneProblem(
  secretKinds: readonly string[],
  policy: AuthPolicy,
): string | undefined {
  if (secretKinds.length === 0) {
    return 'refused: this person has no PIN or password, so nothing could sign them in on the socket (keith-core people pin <username>)'
  }
  return policyProblem(policy, ['loopback'])
}

/**
 * `admin.auth.local.get|set` (docs/specs/auth.md, "The local socket"). Owner only, like the policy:
 * `set` needs a step-up over TCP and is audited (`auth.local.set`). The trust level `none` needs a
 * way for the person to sign in from the loopback (a PIN or a password, and a policy that allows
 * one); `full` needs `acknowledge: true`.
 */
export function authLocalProcedures(options: {
  local: LocalAccess
  people: PeopleService
  policies: PolicyStore
  secretKinds: (personId: string) => readonly string[]
}) {
  const { local, people, policies } = options
  const ownerOnly = (context: RpcContext): void => {
    if (context.principal.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', {
        message: 'only the owner may read or change the local socket settings',
      })
    }
  }
  const target = async (ref: string | undefined, context: RpcContext): Promise<string> => {
    if (ref === undefined) return context.principal.personId
    try {
      return (await people.get(ref)).id
    } catch {
      throw new ORPCError('NOT_FOUND', { message: `no person "${ref.slice(0, 64)}"` })
    }
  }
  return {
    get: rpc.admin.auth.local.get.handler(async ({ input, context }) => {
      ownerOnly(context)
      return local.view(await target(input.person, context))
    }),
    set: rpc.admin.auth.local.set.handler(async ({ input, context }) => {
      ownerOnly(context)
      const personId = await target(input.person, context)
      const before = local.view(personId)
      if (input.trust !== undefined && input.trust !== before.trust) {
        if (input.trust === 'none') {
          const problem = trustNoneProblem(options.secretKinds(personId), policies.get())
          if (problem !== undefined) throw new ORPCError('BAD_REQUEST', { message: problem })
        }
        if (input.trust === 'full' && input.acknowledge !== true) {
          throw new ORPCError('BAD_REQUEST', {
            message:
              'full trust needs acknowledge: true (anyone at the keyboard of this machine is the owner)',
          })
        }
        local.setTrust(personId, input.trust)
      }
      if (input.idleMinutes !== undefined) local.setIdleMinutes(input.idleMinutes)
      const view = local.view(personId)
      context.record('auth.local.set', {
        personId,
        trust: view.trust,
        wasTrust: before.trust,
        idleMinutes: view.idleMinutes,
        wasIdleMinutes: before.idleMinutes,
        ...(input.trust === 'full' && input.trust !== before.trust ? { acknowledged: true } : {}),
      })
      return view
    }),
  }
}
