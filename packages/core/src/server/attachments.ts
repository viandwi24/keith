// Which node has which thread open, and the live sockets frames go out on. Constructed standalone
// (bootstrap step 4) so the mind and the server share one instance. See docs/architecture/nodes.md.

import { CoreFrame } from '@keith/protocol'
import type { Logger, NodeId, ThreadId } from '../shared/types.ts'
import type { AttachmentRegistry } from './types.ts'

/** Where a connected node's frames go. Implemented by the WS connection. */
export type FrameOutlet = { sendText(text: string): void; sendBinary(bytes: Uint8Array): void }

/** The registry plus the connection bookkeeping only the server uses. */
export interface ServerAttachmentRegistry extends AttachmentRegistry {
  /** Registers a live socket for a node. Replaces an earlier outlet for the same node id. */
  connect(nodeId: NodeId, outlet: FrameOutlet): void
  /** Forgets the socket and detaches the node from every thread. */
  disconnect(nodeId: NodeId): void
  isConnected(nodeId: NodeId): boolean
  /** Threads the node has open, in attach order. */
  threadsOf(nodeId: NodeId): ThreadId[]
}

export type AttachmentRegistryDeps = { log: Logger }

export function createAttachmentRegistry(deps: AttachmentRegistryDeps): ServerAttachmentRegistry {
  const log = deps.log.child({ component: 'attachments' })
  const outlets = new Map<NodeId, FrameOutlet>()
  // threadId → node ids in attach order (most recent last; the mind uses it for focus fallback).
  const byThread = new Map<ThreadId, NodeId[]>()

  const detachOne = (nodeId: NodeId, threadId: ThreadId) => {
    const nodes = byThread.get(threadId)
    if (!nodes) return
    const rest = nodes.filter((n) => n !== nodeId)
    if (rest.length === 0) byThread.delete(threadId)
    else byThread.set(threadId, rest)
  }

  const threadsOf = (nodeId: NodeId): ThreadId[] => {
    const out: ThreadId[] = []
    for (const [threadId, nodes] of byThread) if (nodes.includes(nodeId)) out.push(threadId)
    return out
  }

  return {
    attach(nodeId, threadId) {
      const nodes = (byThread.get(threadId) ?? []).filter((n) => n !== nodeId)
      nodes.push(nodeId)
      byThread.set(threadId, nodes)
    },
    detach(nodeId, threadId) {
      if (threadId !== undefined) {
        detachOne(nodeId, threadId)
        return
      }
      for (const t of threadsOf(nodeId)) detachOne(nodeId, t)
    },
    attachedTo(threadId) {
      return [...(byThread.get(threadId) ?? [])]
    },
    send(nodeId, frame) {
      const outlet = outlets.get(nodeId)
      if (!outlet) return
      // R-9: outgoing frames are validated too. An invalid frame is a core bug, never sent.
      const parsed = CoreFrame.safeParse(frame)
      if (!parsed.success) {
        log.error('invalid outgoing frame dropped', {
          nodeId,
          type: frame.type,
          issues: parsed.error.message,
        })
        return
      }
      outlet.sendText(JSON.stringify(frame))
    },
    sendBinary(nodeId, bytes) {
      outlets.get(nodeId)?.sendBinary(bytes)
    },
    connect(nodeId, outlet) {
      outlets.set(nodeId, outlet)
    },
    disconnect(nodeId) {
      outlets.delete(nodeId)
      for (const t of threadsOf(nodeId)) detachOne(nodeId, t)
    },
    isConnected(nodeId) {
      return outlets.has(nodeId)
    },
    threadsOf,
  }
}
