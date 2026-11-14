import {
  type CoreToNode,
  NODE_CHANGED,
  type Node,
  type NodeManifest,
  type NodeToCore,
  PROTOCOL_VERSION,
  type RefusalReason,
} from '@keith/contracts'
import type { NodeRecord, NodesRepo } from '@keith/db'
import { uuidv7 } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { emit } from '../brain-events/index.ts'
import {
  type Acceptance,
  acceptStored,
  createNodeCapabilityRegistry,
  driverChanges,
  type NodeCapabilityRegistry,
} from './node-capabilities.ts'
import type {
  CapabilityRefused,
  DriversChanged,
  InvokeErrorCode,
  InvokeOptions,
  InvokeOutcome,
  LocalNode,
  NodeRegistry,
  NodeSocket,
} from './types.ts'

/** Extra wait on top of the call timeout: the node reports its own timeout first when it can. */
export const TIMEOUT_GRACE_MS = 1_000
/** Core closes a socket that sent no heartbeat for this long. */
export const HEARTBEAT_TIMEOUT_MS = 30_000

export interface RegistryOptions {
  nodes: NodesRepo
  store: ActivityStore
  local: LocalNode
  heartbeatTimeoutMs?: number
  timeoutGraceMs?: number
  warn?: (message: string) => void
  now?: () => number
  /** The capability specs and their refusal rules: built-in unless given. `createNodes` freezes it at boot. */
  capabilities?: NodeCapabilityRegistry
  /** A node's driver set changed between two connections (one call per connection that changed it). */
  onDriversChanged?: (info: DriversChanged) => void
  /** A capability the core refused on a connection (called once per distinct refusal per connection). */
  onCapabilityRefused?: (info: CapabilityRefused) => void
}

/** The text a refusal reason reads as, for the caller of a refused capability. */
const REFUSAL_TEXT: Record<RefusalReason, string> = {
  'unknown-capability': 'the core does not know this capability',
  'unsupported-schema': 'the core does not speak this schema version',
  'driver-mismatch': 'the driver does not provide this capability',
  'wrong-layer': 'a node cannot provide a client capability',
}

/** The registry with the gateway's side: sockets come and go, messages arrive. */
export interface NodeHub extends NodeRegistry {
  /** A node said hello on `socket`. False when the node is unknown or revoked. */
  connect(nodeId: string, socket: NodeSocket, manifest: NodeManifest): boolean
  /** Any message of a connected node after the hello. */
  receive(nodeId: string, message: NodeToCore): void
  /** The socket closed (or core dropped it). */
  disconnect(nodeId: string, socket: NodeSocket): void
  /** Mark nodes without a recent heartbeat offline and drop their sockets. */
  sweep(): void
  /** Close every socket (shutdown). */
  closeAll(): void
}

interface Connection {
  socket: NodeSocket
  lastBeat: number
}

interface PendingCall {
  nodeId: string
  onProgress: InvokeOptions['onProgress']
  finish(outcome: InvokeOutcome): void
}

const fail = (code: InvokeErrorCode, message: string): InvokeOutcome => ({
  ok: false,
  code,
  message,
})

/**
 * The node registry: who is paired, who is connected, and calls with a `callId` that find their
 * way back. State of a connection lives in memory; the `nodes` table keeps what survives a restart.
 */
export function createRegistry(options: RegistryOptions): NodeHub {
  const { nodes, store, local } = options
  const now = options.now ?? Date.now
  const grace = options.timeoutGraceMs ?? TIMEOUT_GRACE_MS
  const beatTimeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  const connections = new Map<string, Connection>()
  const calls = new Map<string, PendingCall>()
  const capabilities = options.capabilities ?? createNodeCapabilityRegistry()
  const acceptanceOf = (record: NodeRecord | undefined): Acceptance =>
    acceptStored(capabilities, record?.manifest)
  /** The schema version a node's capability runs at (the core's own built-ins are at their spec version). */
  const schemaVersionOf = (node: Node, id: string): number | undefined => {
    if (node.id === local.node().id) return capabilities.get(id)?.version
    return acceptanceOf(nodes.get(node.id)).accepted.find((a) => a.id === id)?.schemaVersion
  }

  const toNode = (record: NodeRecord): Node => {
    const acceptance = acceptanceOf(record)
    return {
      id: record.id,
      name: record.name,
      os: record.os,
      arch: record.arch,
      version: record.version,
      capabilities: acceptance.accepted.map((a) => a.id),
      drivers: acceptance.drivers,
      refused: acceptance.refused,
      allowShell: record.allowShell,
      status:
        record.status === 'revoked' ? 'revoked' : connections.has(record.id) ? 'online' : 'offline',
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt,
    }
  }

  const announce = (record: NodeRecord | undefined): void => {
    if (record === undefined) return
    emit(store, NODE_CHANGED, null, null, { node: toNode(record) }, options.warn)
  }

  const send = (socket: NodeSocket, message: CoreToNode): boolean => {
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  const failCallsOf = (nodeId: string, message: string): void => {
    for (const call of [...calls.values()]) {
      if (call.nodeId === nodeId) call.finish(fail('failed', message))
    }
  }

  const list = (): Node[] => [local.node(), ...nodes.list().map(toNode)]
  const find = (ref: string): Node | undefined => {
    const all = list()
    return all.find((n) => n.name === ref) ?? all.find((n) => n.id === ref)
  }

  function invokeRemote(
    node: Node,
    connection: Connection,
    capability: string,
    input: unknown,
    opts: InvokeOptions,
    capabilityVersion: number | undefined,
  ): Promise<InvokeOutcome> {
    return new Promise((resolve) => {
      const callId = uuidv7()
      const cancel = (): void => {
        send(connection.socket, { v: PROTOCOL_VERSION, type: 'cancel', callId })
      }
      let settled = false
      const finish = (outcome: InvokeOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        calls.delete(callId)
        resolve(outcome)
      }
      const onAbort = (): void => {
        cancel()
        finish(fail('cancelled', 'cancelled'))
      }
      const timer = setTimeout(() => {
        cancel()
        finish(
          fail('timeout', `${capability} on ${node.name} timed out after ${opts.timeoutMs} ms`),
        )
      }, opts.timeoutMs + grace)
      calls.set(callId, { nodeId: node.id, onProgress: opts.onProgress, finish })
      if (opts.signal?.aborted === true) return finish(fail('cancelled', 'cancelled'))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const sent = send(connection.socket, {
        v: PROTOCOL_VERSION,
        type: 'invoke',
        callId,
        capability,
        input,
        timeoutMs: opts.timeoutMs,
        ...(capabilityVersion === undefined ? {} : { capabilityVersion }),
      })
      if (!sent) finish(fail('failed', `could not reach node ${node.name}`))
    })
  }

  const hub: NodeHub = {
    list,
    find,
    async invoke(ref, capability, input, opts) {
      const node = find(ref)
      if (node === undefined) {
        const names = list().map((n) => n.name)
        return fail('unknown-node', `no node "${ref}" (known: ${names.join(', ')})`)
      }
      if (!node.capabilities.includes(capability)) {
        const refusal = node.refused.find((r) => r.id === capability)
        if (refusal !== undefined)
          return fail(
            'unknown-capability',
            `node ${node.name} refused "${capability}": ${REFUSAL_TEXT[refusal.reason]}`,
          )
        return fail(
          'unknown-capability',
          `node ${node.name} has no capability "${capability}" (available: ${node.capabilities.join(', ')})`,
        )
      }
      if (node.id === local.node().id) {
        const signal = opts.signal ?? new AbortController().signal
        return local.run(capability, input, { ...opts, signal })
      }
      const connection = connections.get(node.id)
      if (connection === undefined) return fail('offline', `node ${node.name} is offline`)
      return invokeRemote(
        node,
        connection,
        capability,
        input,
        opts,
        schemaVersionOf(node, capability),
      )
    },
    byCapability(id, opts) {
      // online nodes first; the core's own node counts as online
      return list()
        .filter(
          (n) =>
            n.capabilities.includes(id) &&
            (opts?.version === undefined || schemaVersionOf(n, id) === opts.version),
        )
        .sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'))
    },
    revoke(id) {
      if (id === local.node().id) return undefined
      const record = nodes.revoke(id)
      if (record === undefined) return undefined
      const connection = connections.get(id)
      connections.delete(id)
      failCallsOf(id, 'node revoked')
      connection?.socket.close(4003, 'revoked')
      announce(record)
      return toNode(record)
    },
    connect(nodeId, socket, manifest) {
      const record = nodes.get(nodeId)
      if (record === undefined || record.status === 'revoked') return false
      const previous = connections.get(nodeId)
      const before = acceptanceOf(record).drivers
      connections.set(nodeId, { socket, lastBeat: now() })
      if (previous !== undefined && previous.socket !== socket) {
        failCallsOf(nodeId, 'node reconnected')
        previous.socket.close(4001, 'replaced by a newer connection')
      }
      nodes.updateManifest(nodeId, {
        os: manifest.os,
        arch: manifest.arch,
        version: manifest.version,
        manifest,
        allowShell: manifest.policy.allowShell,
      })
      const acceptance = capabilities.accept(manifest)
      const changes = driverChanges(before, acceptance.drivers)
      if (changes.length > 0) options.onDriversChanged?.({ nodeId, name: record.name, changes })
      const seen = new Set<string>()
      for (const refusal of acceptance.refused) {
        const key = `${refusal.id}@${refusal.schemaVersion}:${refusal.reason}`
        if (seen.has(key)) continue
        seen.add(key)
        options.onCapabilityRefused?.({ nodeId, name: record.name, ...refusal })
      }
      announce(nodes.setStatus(nodeId, 'online', now()))
      return true
    },
    receive(nodeId, message) {
      const connection = connections.get(nodeId)
      if (connection === undefined) return
      if (message.type === 'heartbeat') {
        connection.lastBeat = now()
        nodes.touch(nodeId)
        return
      }
      if (message.type !== 'progress' && message.type !== 'result') return
      const call = calls.get(message.callId)
      // a node only answers its own calls
      if (call === undefined || call.nodeId !== nodeId) return
      if (message.type === 'progress') {
        call.onProgress?.(message.chunk, message.stream)
        return
      }
      call.finish(
        message.ok
          ? {
              ok: true,
              output: message.output,
              ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
            }
          : fail(message.error.code, message.error.message),
      )
    },
    disconnect(nodeId, socket) {
      const connection = connections.get(nodeId)
      if (connection === undefined || connection.socket !== socket) return
      connections.delete(nodeId)
      failCallsOf(nodeId, 'node disconnected')
      announce(nodes.setStatus(nodeId, 'offline'))
    },
    sweep() {
      for (const [nodeId, connection] of [...connections]) {
        if (now() - connection.lastBeat <= beatTimeout) continue
        options.warn?.(`node ${nodeId}: no heartbeat for ${beatTimeout} ms, marking it offline`)
        hub.disconnect(nodeId, connection.socket)
        connection.socket.close(4008, 'heartbeat timeout')
      }
    },
    closeAll() {
      for (const [nodeId, connection] of [...connections]) {
        hub.disconnect(nodeId, connection.socket)
        connection.socket.close(1001, 'core is shutting down')
      }
    },
  }
  // a crash leaves rows saying online: nothing is connected yet
  for (const record of nodes.list()) {
    if (record.status === 'online') nodes.setStatus(record.id, 'offline')
  }
  return hub
}
