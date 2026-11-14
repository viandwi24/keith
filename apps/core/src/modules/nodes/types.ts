import type { Node, RefusalReason } from '@keith/contracts'

/** Why a call to a node did not produce an output. */
export type InvokeErrorCode =
  | 'unknown-node'
  | 'offline'
  | 'unknown-capability'
  | 'unsupported-version'
  | 'driver-unavailable'
  | 'refused-by-policy'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'failed'

export type InvokeOutcome =
  | { ok: true; output: unknown; exitCode?: number }
  | { ok: false; code: InvokeErrorCode; message: string }

export interface InvokeOptions {
  /** Wall clock the node gets; core waits a short grace on top before it gives up. */
  timeoutMs: number
  /** Abort sends `cancel` to the node and settles `cancelled`. */
  signal?: AbortSignal | undefined
  onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

/** The part of a socket the registry needs (Bun's `ServerWebSocket` fits). */
export interface NodeSocket {
  send(data: string): unknown
  close(code?: number, reason?: string): unknown
}

/** What runs a capability inside core (the node `core`). */
export interface LocalNode {
  node(): Node
  run(
    capability: string,
    input: unknown,
    options: InvokeOptions & { signal: AbortSignal },
  ): Promise<InvokeOutcome>
}

/** Nodes as the rest of core sees them: list, find, call, revoke. */
export interface NodeRegistry {
  /** `core` first, then the paired nodes (revoked ones are not listed). */
  list(): Node[]
  /** By name (slug) or id. */
  find(ref: string): Node | undefined
  invoke(
    ref: string,
    capability: string,
    input: unknown,
    options: InvokeOptions,
  ): Promise<InvokeOutcome>
  /** Nodes that accept a capability, online first. `version` keeps the nodes that run it at that schema version. */
  byCapability(id: string, options?: { version?: number }): Node[]
  /** Revoke a paired node: its token never matches again and its socket closes. */
  revoke(id: string): Node | undefined
}

/** One change of a node's driver set between two connections (names and versions only). */
export interface DriverChange {
  name: string
  version: string
  change: 'added' | 'removed' | 'changed'
}

export interface DriversChanged {
  nodeId: string
  name: string
  changes: DriverChange[]
}

export interface CapabilityRefused {
  nodeId: string
  name: string
  id: string
  schemaVersion: number
  reason: RefusalReason
}
