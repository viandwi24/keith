// Nodes: pairing, WebSocket gateway, registry and the in-process `core` node
// (docs/specs/nodes.md).
export { CORE_NODE_ID, type CoreNodeOptions, createCoreNode } from './core-node.ts'
export { type Gateway, NODE_TOKEN_MAX_AGE_MS, type NodeSocketData } from './gateway.ts'
export {
  type Acceptance,
  type AcceptedCapability,
  acceptStored,
  BUILTIN_CAPABILITY_SPECS,
  createNodeCapabilityRegistry,
  type NodeCapabilityRegistry,
  type RefusedCapability,
} from './node-capabilities.ts'
export { createNodes, type Nodes, type NodesOptions } from './nodes.ts'
export { PAIRING_TTL_MS, type Pairing } from './pairing.ts'
export { nodeProcedures } from './procedures.ts'
export { HEARTBEAT_TIMEOUT_MS, TIMEOUT_GRACE_MS } from './registry.ts'
export type {
  CapabilityRefused,
  DriverChange,
  DriversChanged,
  InvokeErrorCode,
  InvokeOptions,
  InvokeOutcome,
  LocalNode,
  NodeRegistry,
} from './types.ts'
