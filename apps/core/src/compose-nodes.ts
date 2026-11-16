// The nodes wiring (docs/specs/nodes.md): the hub over the node tables, the capability registry (built-in and the core's extra
// specs), the timing of heartbeats and pairing, and the audit rows of pairing, rate limits, drivers, refused capabilities and token
// rotation. Called once by `wireFront` (compose-regions.ts).

import { nodesRepo, pairingRepo } from '@keith/db'
import type { Wiring } from './compose-regions.ts'
import {
  BUILTIN_CAPABILITY_SPECS,
  createNodeCapabilityRegistry,
  createNodes,
} from './modules/nodes/index.ts'
import { reachableUrl } from './platform/net.ts'

export function wireNodes(w: Wiring): ReturnType<typeof createNodes> {
  const { config, logger, sqlite, store, timing } = w
  const { audit } = w.identity
  return createNodes({
    capabilities: createNodeCapabilityRegistry([
      ...BUILTIN_CAPABILITY_SPECS,
      ...(w.nodeCapabilities ?? []),
    ]),
    nodes: nodesRepo(sqlite),
    pairing: pairingRepo(sqlite),
    store,
    version: w.version,
    allowCoreShell: config.allowCoreShell,
    shellEnv: config.shellEnv,
    publicUrl: () => {
      const net = w.network()
      return net.publicUrl ?? reachableUrl(net.host, w.bound.port ?? net.port)
    },
    timing: {
      heartbeatMs: timing.nodeHeartbeatMs,
      heartbeatTimeoutMs: timing.nodeHeartbeatTimeoutMs,
      sweepEveryMs: timing.nodeSweepEveryMs,
      pairingTtlMs: timing.pairingTtlMs,
      timeoutGraceMs: timing.nodeTimeoutGraceMs,
      rotateAfterMs: timing.nodeTokenRotateMs,
    },
    onPaired: ({ nodeId, name, ip }) =>
      audit.record({
        kind: 'node.paired',
        actor: 'system',
        via: 'tcp',
        detail: { nodeId, name, ip },
      }),
    onRateLimited: (nodeId) =>
      audit.record({
        kind: 'node.rate_limited',
        actor: 'system',
        via: 'tcp',
        detail: { node: nodeId },
      }),
    onDriversChanged: ({ nodeId, name, changes }) =>
      audit.record({
        kind: 'node.drivers',
        actor: 'system',
        via: 'tcp',
        detail: { nodeId, name, drivers: changes },
      }),
    onCapabilityRefused: ({ nodeId, name, id, schemaVersion, reason }) =>
      audit.record({
        kind: 'node.capability.refused',
        actor: 'system',
        via: 'tcp',
        detail: { nodeId, name, id, schemaVersion, reason },
      }),
    onRotated: ({ nodeId, name }) =>
      audit.record({
        kind: 'node.token.rotated',
        actor: 'system',
        via: 'tcp',
        detail: { nodeId, name },
      }),
    warn: (message) => logger.warn(message),
  })
}
