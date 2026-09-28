// Which node has which thread open, and the live sockets frames go out on. Constructed standalone
// (bootstrap step 4) so the mind and the server share one instance. See docs/architecture/nodes.md.

import { CoreFrame } from '@keith/protocol'
import type { Logger, NodeId, PersonId, ThreadId } from '../shared/types.ts'
import type { AttachmentRegistry } from './types.ts'

/** Where a connected node's frames go. Implemented by the WS connection. */
export type FrameOutlet = { sendText(text: string): void; sendBinary(bytes: Uint8Array): void }

/** The registry plus the connection bookkeeping only the server uses. */
export interface ServerAttachmentRegistry extends AttachmentRegistry {
  /**
   * Registers a live socket for a node of `personId` (the token's person) with the capabilities it
   * declared in `hello`. Replaces an earlier outlet for the same node id.
   */
  connect(nodeId: NodeId, outlet: FrameOutlet, capabilities: readonly string[], personId: PersonId): void
  /**
   * The node got `welcome`. Only from now on `nodesOfPerson` lists it, so no frame of the thread
   * list reaches a node before its `welcome`. No-op for an unknown node.
   */
  markReady(nodeId: NodeId): void
  /** Forgets the socket and detaches the node from every thread. */
  disconnect(nodeId: NodeId): void
  isConnected(nodeId: NodeId): boolean
  /** Threads the node has open, in attach order. */
  threadsOf(nodeId: NodeId): ThreadId[]
}

export type AttachmentRegistryDeps = { log: Logger }

const CHAT_TEXT_CAPABILITY = 'chat.text@1'

/** Frames only a node with `chat.text@1` receives (protocol.md#delivery-rules). */
const CHAT_TEXT_FRAMES: ReadonlySet<string> = new Set([
  'message.user',
  'message.started',
  'message.delta',
  'message.completed',
  'tool.activity',
])

type Connected = FrameOutlet & { chatText: boolean; personId: PersonId; ready: boolean }

export function createAttachmentRegistry(deps: AttachmentRegistryDeps): ServerAttachmentRegistry {
  const log = deps.log.child({ component: 'attachments' })
  const outlets = new Map<NodeId, Connected>()
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
    nodesOfPerson(personId) {
      const out: NodeId[] = []
      for (const [nodeId, outlet] of outlets)
        if (outlet.ready && outlet.personId === personId) out.push(nodeId)
      return out
    },
    send(nodeId, frame) {
      const outlet = outlets.get(nodeId)
      if (!outlet) return
      if (!outlet.chatText && CHAT_TEXT_FRAMES.has(frame.type)) return
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
    connect(nodeId, outlet, capabilities, personId) {
      outlets.set(nodeId, {
        personId,
        ready: false,
        sendText: (text) => outlet.sendText(text),
        sendBinary: (bytes) => outlet.sendBinary(bytes),
        chatText: capabilities.includes(CHAT_TEXT_CAPABILITY),
      })
    },
    markReady(nodeId) {
      const outlet = outlets.get(nodeId)
      if (outlet) outlet.ready = true
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
