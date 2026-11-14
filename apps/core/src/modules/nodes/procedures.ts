import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { NodeCallLimitSettings } from '../motor/index.ts'
import { CORE_NODE_ID } from './core-node.ts'
import { type Pairing, PairingLimitError } from './pairing.ts'
import type { NodeRegistry } from './types.ts'

export interface NodeProceduresOptions {
  registry: NodeRegistry
  pairing: Pairing
  /** The owner's limit of the sandbox calls per hour (`nodes.settings.*`, node-drivers.md "Settings"). */
  callLimit: NodeCallLimitSettings
}

/** oRPC `nodes.list`, `nodes.pair`, `nodes.revoke` and `nodes.settings.get|set` (the Keith contract). */
export function nodeProcedures(options: NodeProceduresOptions) {
  return {
    settings: {
      get: rpc.nodes.settings.get.handler(() => options.callLimit.get()),
      set: rpc.nodes.settings.set.handler(({ input, context }) => {
        let change: ReturnType<NodeCallLimitSettings['set']>
        try {
          change = options.callLimit.set(input.maxPerHourPerPerson)
        } catch (error) {
          if (error instanceof RangeError)
            throw new ORPCError('BAD_REQUEST', { message: error.message })
          throw error
        }
        context.record('settings.nodes.set', change)
        return options.callLimit.get()
      }),
    },
    // Every person with `nodes.read` (all members, ROLE_CAPABILITIES) sees every node, its capabilities
    // and its shell flag: nodes are Keith's self layer, not a per-person resource (ADR-0027 §9, Q-010).
    // OWN-008's "their own" is limited to activity and tasks (permissions.md).
    list: rpc.nodes.list.handler(() => options.registry.list()),
    pair: rpc.nodes.pair.handler(async ({ context }) => {
      try {
        return await options.pairing.issue(context.principal.personId)
      } catch (error) {
        if (error instanceof PairingLimitError) {
          throw new ORPCError('TOO_MANY_REQUESTS', { message: error.message })
        }
        throw error
      }
    }),
    revoke: rpc.nodes.revoke.handler(({ input }) => {
      if (input.id === CORE_NODE_ID) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'core is not a paired node: it cannot be revoked',
        })
      }
      const node = options.registry.revoke(input.id) ?? revokedByName(options.registry, input.id)
      if (node === undefined) throw new ORPCError('NOT_FOUND', { message: `no node ${input.id}` })
      return { ok: true as const }
    }),
  }
}

/** The owner may type the name the panel shows instead of the id. */
function revokedByName(registry: NodeRegistry, ref: string) {
  const node = registry.find(ref)
  return node === undefined ? undefined : registry.revoke(node.id)
}
