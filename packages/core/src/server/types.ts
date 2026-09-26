// Server-side interfaces other folders use. Protocol: docs/contracts/protocol.md; nodes, focus and
// presence: docs/architecture/nodes.md. Implemented by server/ (task P1-C1).

import type { CoreFrame } from '@keith/protocol'
import type { HttpRegistry, WsRegistry } from '@keith/sdk'
import type { PluginScoped } from '../plugins/types.ts'
import type { NodeId, PersonId, ThreadId } from '../shared/types.ts'

/** Constructed first; shared by server and mind (breaks the cycle). */
export interface AttachmentRegistry {
  attach(nodeId: NodeId, threadId: ThreadId): void
  /** Without `threadId`: detach the node from every thread. */
  detach(nodeId: NodeId, threadId?: ThreadId | undefined): void
  attachedTo(threadId: ThreadId): NodeId[]
  /** No-op if the node is gone. */
  send(nodeId: NodeId, frame: CoreFrame): void
}

export type NodeSink = Pick<AttachmentRegistry, 'send' | 'attachedTo'>

export interface Presence {
  isPresent(personId: PersonId): boolean
  /** Persisted in persons.last_seen_at. */
  lastSeenAt(personId: PersonId): number | null
  /** Writes last_seen_at for everyone present (shutdown). */
  flushPresence(): Promise<void>
}

/** The HTTP + WS server (bootstrap steps 9 and 12). */
export interface CoreServer {
  /** Plugin routes under `/p/<namespace>/…` (handed to the plugin host). */
  http: PluginScoped<HttpRegistry>
  /** Plugin frame types `<namespace>.*` (handed to the plugin host). */
  ws: PluginScoped<WsRegistry>
  /** Starts listening on `server.host:port`. */
  listen(): Promise<{ host: string; port: number }>
  /** Stops accepting connections and closes open sockets. */
  stop(): Promise<void>
}
