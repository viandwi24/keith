import { tool } from 'ai'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import type { NodeRegistry } from '../nodes/index.ts'

export const NODES_STATUS_TOOL = 'nodes_status'

/** Plugin of `nodes_status`: which machines exist, whether they are online, what they allow. */
export function nodesStatus(options: { nodes: NodeRegistry }): HarnessPlugin<'keith-nodes-status'> {
  const status = tool({
    description:
      'List the machines paired with Keith (and "core"): name, online/offline, OS, drivers (name and version), capabilities, capabilities refused with the reason, and whether shell commands are allowed there.',
    inputSchema: z.object({}),
    metadata: { risk: 'read', source: 'trusted' },
    execute: async () => ({
      nodes: options.nodes.list().map((n) => ({
        name: n.name,
        status: n.status,
        os: n.os,
        arch: n.arch,
        capabilities: n.capabilities,
        drivers: n.drivers,
        refused: n.refused.map((r) => ({ id: r.id, reason: r.reason })),
        allowShell: n.allowShell,
        lastSeenAt: n.lastSeenAt === null ? null : new Date(n.lastSeenAt).toISOString(),
      })),
    }),
  })
  return definePlugin({
    name: 'keith-nodes-status',
    setup: () => ({ tools: { [NODES_STATUS_TOOL]: status } }),
  })
}
