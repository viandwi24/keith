import type { NodesRepo, PairingRepo } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import { createCoreNode } from './core-node.ts'
import { createGateway, type Gateway } from './gateway.ts'
import { createNodeCapabilityRegistry, type NodeCapabilityRegistry } from './node-capabilities.ts'
import { createPairing, type Pairing } from './pairing.ts'
import { createRegistry, type NodeHub } from './registry.ts'
import type { CapabilityRefused, DriversChanged, LocalNode } from './types.ts'

export interface NodesOptions {
  nodes: NodesRepo
  pairing: PairingRepo
  store: ActivityStore
  version: string
  /** `KEITH_CORE_ALLOW_SHELL`. */
  allowCoreShell: boolean
  /** Environment of shells run by the node `core`. */
  shellEnv: Record<string, string>
  publicUrl: () => string
  timing: {
    /** Interval the nodes are told to heartbeat at. */
    heartbeatMs: number
    /** No heartbeat for this long: offline. */
    heartbeatTimeoutMs: number
    /** How often the sweeper looks. */
    sweepEveryMs: number
    /** Lifetime of a pairing code. */
    pairingTtlMs: number
    /** Core waits this long after a call's timeout for the node's own answer. */
    timeoutGraceMs: number
    /** A node token older than this is rotated at its next connection (default 30 days). */
    rotateAfterMs?: number
  }
  onPaired?: (info: { nodeId: string; name: string; ip: string }) => void
  /** A node went over its message budget (audited at most once per five minutes). */
  onRateLimited?: (nodeId: string) => void
  /** A node token rotation completed. */
  onRotated?: (info: { nodeId: string; name: string }) => void
  warn?: (message: string) => void
  /** Replaces the `core` node (tests). */
  local?: LocalNode
  /** The capability specs (boot time). Default: the built-in ones. `createNodes` freezes the registry. */
  capabilities?: NodeCapabilityRegistry
  /** A node's driver set changed between two connections (audited as `node.drivers`). */
  onDriversChanged?: (info: DriversChanged) => void
  /** A capability a node announced was refused (audited as `node.capability.refused`, once per connection). */
  onCapabilityRefused?: (info: CapabilityRefused) => void
}

export interface Nodes {
  hub: NodeHub
  /** The capability registry the nodes were accepted against (frozen): motor and approvals read the same one. */
  capabilities: NodeCapabilityRegistry
  gateway: Gateway
  pairing: Pairing
  /** Stop the sweeper and close every node socket. */
  close(): void
}

/** The nodes module: registry, gateway, pairing and the in-process `core` node. */
export function createNodes(options: NodesOptions): Nodes {
  const { timing } = options
  const capabilities = options.capabilities ?? createNodeCapabilityRegistry()
  // registration ends here: the agents start after the nodes module is built
  capabilities.freeze()
  const hub = createRegistry({
    nodes: options.nodes,
    capabilities,
    ...(options.onDriversChanged === undefined
      ? {}
      : { onDriversChanged: options.onDriversChanged }),
    ...(options.onCapabilityRefused === undefined
      ? {}
      : { onCapabilityRefused: options.onCapabilityRefused }),
    store: options.store,
    local:
      options.local ??
      createCoreNode({
        allowShell: options.allowCoreShell,
        version: options.version,
        env: options.shellEnv,
      }),
    heartbeatTimeoutMs: timing.heartbeatTimeoutMs,
    timeoutGraceMs: timing.timeoutGraceMs,
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })
  const gateway = createGateway({
    nodes: options.nodes,
    hub,
    heartbeatMs: timing.heartbeatMs,
    ...(timing.rotateAfterMs === undefined ? {} : { rotateAfterMs: timing.rotateAfterMs }),
    ...(options.onRateLimited === undefined ? {} : { onRateLimited: options.onRateLimited }),
    ...(options.onRotated === undefined ? {} : { onRotated: options.onRotated }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })
  const pairing = createPairing({
    pairing: options.pairing,
    nodes: options.nodes,
    registry: hub,
    store: options.store,
    ttlMs: timing.pairingTtlMs,
    heartbeatMs: timing.heartbeatMs,
    publicUrl: options.publicUrl,
    ...(options.onPaired === undefined ? {} : { onPaired: options.onPaired }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })
  const sweeper = setInterval(() => hub.sweep(), timing.sweepEveryMs)
  return {
    hub,
    capabilities,
    gateway,
    pairing,
    close() {
      clearInterval(sweeper)
      hub.closeAll()
    },
  }
}
