// One WebSocket connection from a Node: handshake, heartbeat and frame routing.
// See docs/architecture/nodes.md#connection-lifecycle and docs/contracts/protocol.md.

import {
  type CoreFrame,
  type CoreFrameType,
  type ErrorCode,
  type FrameData,
  FrameEnvelope,
  makeFrame,
  type NodeFrame,
  PROTOCOL_VERSION,
  parseNodeFrame,
  WS_CLOSE_CODES,
} from '@keith/protocol'
import { isKeithError, type KeithErrorCode } from '@keith/sdk'
import type { CoreEventBus } from '../events/types.ts'
import type { ThreadManager } from '../mind/types.ts'
import type { Clock, Ids, Logger, NodeId, PersonDto, ThreadId } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { ServerAttachmentRegistry } from './attachments.ts'
import type { AuthSession } from './auth.ts'
import { toPersonDto } from './dto.ts'
import type { PluginWs } from './plugin-routes.ts'
import type { ServerPresence } from './presence.ts'

export type ConnectionTiming = {
  /** Close with 4001 if no `hello` arrives in time. Default 5 000. */
  helloTimeoutMs: number
  /** How often the core sends `ping`. Default 25 000. */
  pingIntervalMs: number
  /** Close with 4010 after this long without any frame from the node. Default 60 000. */
  heartbeatTimeoutMs: number
}

export const DEFAULT_TIMING: ConnectionTiming = {
  helloTimeoutMs: 5_000,
  pingIntervalMs: 25_000,
  heartbeatTimeoutMs: 60_000,
}

/** The socket as a connection sees it. */
export type Socket = { sendText(text: string): void; close(code: number, reason: string): void }

export type ConnectionDeps = {
  log: Logger
  clock: Clock
  ids: Ids
  events: CoreEventBus
  repos: Pick<Repositories, 'nodes' | 'authTokens'>
  threads: ThreadManager
  attachments: ServerAttachmentRegistry
  presence: ServerPresence
  pluginWs: PluginWs
  timing: ConnectionTiming
  server: { name: string; version: string }
  /** Ids for frames the server sends (unique per server instance, so per connection too). */
  nextFrameId: () => string
}

export interface Connection {
  message(raw: string | Uint8Array): void
  /** The socket closed (either side). */
  closed(): Promise<void>
}

/** KeithError codes that are also protocol error codes, and pass through to `error` frames as is. */
const SHARED_CODES: ReadonlySet<string> = new Set<ErrorCode & KeithErrorCode>([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PROVIDER_ERROR',
  'INTERNAL',
])

function errorCodeOf(error: unknown): ErrorCode {
  if (isKeithError(error) && SHARED_CODES.has(error.code)) return error.code as ErrorCode
  return 'INTERNAL'
}

export function openConnection(
  deps: ConnectionDeps,
  socket: Socket,
  session: AuthSession | null,
): Connection {
  const baseLog = deps.log.child({ component: 'ws' })
  if (!session) {
    socket.close(WS_CLOSE_CODES.invalidToken, 'invalid or expired token')
    return { message() {}, closed: async () => {} }
  }
  const person: PersonDto = toPersonDto(session.person)
  let log = baseLog.child({ personId: person.id })
  let phase: 'awaiting-hello' | 'handshaking' | 'ready' | 'closed' = 'awaiting-hello'
  let nodeId: NodeId | null = null
  let chain: Promise<void> = Promise.resolve()

  const send = <T extends CoreFrameType>(type: T, data: FrameData<T>, re?: string | undefined) => {
    if (phase === 'closed') return
    const frame = makeFrame(type, data, { id: deps.nextFrameId(), ts: deps.clock.now(), re }) as CoreFrame
    if (nodeId && phase === 'ready') deps.attachments.send(nodeId, frame)
    else socket.sendText(JSON.stringify(frame))
  }
  const sendError = (code: ErrorCode, message: string, re?: string | undefined) =>
    send('error', { code, message }, re)

  const close = (code: number, reason: string) => {
    if (phase === 'closed') return
    socket.close(code, reason)
  }

  const helloTimer = setTimeout(
    () => close(WS_CLOSE_CODES.helloTimeout, 'no hello received'),
    deps.timing.helloTimeoutMs,
  )
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  const resetSilence = () => {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(
      () => close(WS_CLOSE_CODES.heartbeatTimeout, 'heartbeat timeout'),
      deps.timing.heartbeatTimeoutMs,
    )
  }
  resetSilence()
  const pingTimer = setInterval(() => send('ping', {}), deps.timing.pingIntervalMs)

  const failed = (what: string, error: unknown, re: string) => {
    log.error('frame handling failed', { frame: what, error: String(error) })
    sendError(errorCodeOf(error), isKeithError(error) ? error.message : 'internal error', re)
  }

  const chooseNodeId = async (requested: NodeId | undefined): Promise<NodeId> => {
    for (const candidate of [requested, session.token.nodeId]) {
      if (!candidate || deps.attachments.isConnected(candidate)) continue
      if (await deps.repos.nodes.get(candidate)) return candidate
    }
    return deps.ids.next('nod')
  }

  const hello = async (frame: Extract<NodeFrame, { type: 'hello' }>) => {
    phase = 'handshaking'
    clearTimeout(helloTimer)
    try {
      let id = await chooseNodeId(frame.data.nodeId)
      // Checked again without an await in between, so two sockets never share a node id.
      if (deps.attachments.isConnected(id)) id = deps.ids.next('nod')
      if (phase !== 'handshaking') return // closed meanwhile
      deps.attachments.connect(id, { sendText: (text) => socket.sendText(text) })
      nodeId = id
      log = log.child({ nodeId: id })
      await deps.repos.nodes.upsert({
        id,
        name: frame.data.client.name,
        kind: 'attended',
        capabilities: frame.data.capabilities,
        lastSeenAt: deps.clock.now(),
      })
      if (session.token.nodeId !== id) await deps.repos.authTokens.setNode(session.tokenHash, id)
      if (phase !== 'handshaking') return
      deps.presence.remember(person.id, session.person.lastSeenAt)
      phase = 'ready'
      send('welcome', { nodeId: id, person, protocol: PROTOCOL_VERSION, server: deps.server }, frame.id)
      deps.events.emit('node.connected', {
        nodeId: id,
        personId: person.id,
        capabilities: frame.data.capabilities,
      })
      log.info('node connected', { client: frame.data.client.name })
    } catch (error) {
      log.error('handshake failed', { error: String(error) })
      close(1011, 'internal error')
    }
  }

  const isOpenHere = (threadId: ThreadId) =>
    nodeId !== null && deps.attachments.threadsOf(nodeId).includes(threadId)

  const openThread = async (node: NodeId, frame: Extract<NodeFrame, { type: 'thread.open' }>) => {
    const arrival = await deps.presence.arrivalFor(person.id)
    const opened = await deps.threads.open({
      personId: person.id,
      nodeId: node,
      threadId: frame.data.threadId,
      arrival,
    })
    if (phase !== 'ready') {
      deps.threads.detach({ nodeId: node, threadId: opened.thread.id })
      return
    }
    deps.attachments.attach(node, opened.thread.id)
    deps.presence.nodeAttached(person.id, node)
    const limit = frame.data.historyLimit ?? 50
    const messages = limit === 0 ? [] : opened.messages.slice(-limit)
    send('thread.opened', { thread: opened.thread, messages }, frame.id)
    if (arrival) deps.presence.announceArrival(person.id, arrival)
  }

  const closeThread = async (node: NodeId, threadId: ThreadId) => {
    if (!isOpenHere(threadId)) return
    deps.attachments.detach(node, threadId)
    deps.threads.detach({ nodeId: node, threadId })
    if (deps.attachments.threadsOf(node).length === 0) await deps.presence.nodeDetached(person.id, node)
  }

  const pluginFrame = async (value: unknown, fallback: { message: string; frameId?: string | undefined }) => {
    const envelope = FrameEnvelope.safeParse(value)
    const entry = envelope.success ? deps.pluginWs.find(envelope.data.type) : undefined
    if (!envelope.success || !entry) {
      sendError('UNKNOWN_FRAME', fallback.message, fallback.frameId)
      return
    }
    if (phase !== 'ready' || !nodeId) {
      sendError('INVALID_FRAME', 'expected hello first', envelope.data.id)
      return
    }
    const data = entry.schema.safeParse(envelope.data.data)
    if (!data.success) {
      sendError('INVALID_FRAME', `invalid data for ${entry.type}`, envelope.data.id)
      return
    }
    try {
      await entry.handler(data.data, { nodeId, person })
    } catch (error) {
      log.error('plugin frame handler failed', {
        type: entry.type,
        pluginId: entry.pluginId,
        error: String(error),
      })
      sendError('INTERNAL', 'internal error', envelope.data.id)
    }
  }

  const handleText = async (text: string) => {
    const result = parseNodeFrame(text)
    if (!result.ok) {
      if (result.code === 'UNSUPPORTED_PROTOCOL') {
        close(WS_CLOSE_CODES.unsupportedProtocol, result.message)
        return
      }
      if (result.code === 'UNKNOWN_FRAME') {
        await pluginFrame(JSON.parse(text), { message: result.message, frameId: result.frameId })
        return
      }
      sendError(result.code, result.message, result.frameId)
      return
    }
    const frame = result.frame
    if (frame.type === 'hello') {
      if (phase !== 'awaiting-hello') sendError('INVALID_FRAME', 'hello already received', frame.id)
      else await hello(frame)
      return
    }
    if (phase !== 'ready' || !nodeId) {
      sendError('INVALID_FRAME', 'expected hello first', frame.id)
      return
    }
    const node = nodeId
    try {
      switch (frame.type) {
        case 'thread.open':
          await openThread(node, frame)
          return
        case 'thread.close':
          await closeThread(node, frame.data.threadId)
          return
        case 'input.text': {
          if (!isOpenHere(frame.data.threadId)) {
            sendError('FORBIDDEN', 'thread is not open on this node', frame.id)
            return
          }
          // Not awaited: a turn may run long, and input.cancel must still get through.
          deps.threads
            .input({
              threadId: frame.data.threadId,
              personId: person.id,
              nodeId: node,
              modality: 'text',
              text: frame.data.text,
            })
            .catch((error: unknown) => failed(frame.type, error, frame.id))
          return
        }
        case 'input.cancel':
          if (!isOpenHere(frame.data.threadId)) {
            sendError('FORBIDDEN', 'thread is not open on this node', frame.id)
            return
          }
          deps.threads.cancel({ threadId: frame.data.threadId, nodeId: node })
          return
        case 'pong':
          return
        case 'ui.action':
          sendError('UNKNOWN_FRAME', 'ui.action is not supported yet (phase 2)', frame.id)
          return
      }
    } catch (error) {
      failed(frame.type, error, frame.id)
    }
  }

  return {
    message(raw) {
      if (phase === 'closed') return
      resetSilence()
      if (typeof raw !== 'string') {
        sendError('INVALID_FRAME', 'binary frames are not supported yet (phase 3)')
        return
      }
      // Frames are handled one at a time, in order.
      chain = chain
        .then(() => handleText(raw))
        .catch((error: unknown) => log.error('frame handling failed', { error: String(error) }))
    },
    async closed() {
      const wasReady = phase === 'ready'
      phase = 'closed'
      clearTimeout(helloTimer)
      clearTimeout(silenceTimer)
      clearInterval(pingTimer)
      await chain
      if (!nodeId) return
      const node = nodeId
      const hadThreads = deps.attachments.threadsOf(node).length > 0
      deps.attachments.disconnect(node)
      if (!wasReady) return
      deps.threads.detach({ nodeId: node })
      try {
        if (hadThreads) await deps.presence.nodeDetached(person.id, node)
        await deps.repos.nodes.touch(node, deps.clock.now())
      } catch (error) {
        log.error('node disconnect bookkeeping failed', { error: String(error) })
      }
      deps.events.emit('node.disconnected', { nodeId: node, personId: person.id })
      log.info('node disconnected')
    },
  }
}
