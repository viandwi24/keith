import {
  type ClientInfo,
  type CoreFrame,
  DEFAULT_HISTORY_LIMIT,
  type FrameData,
  type FrameOf,
  INPUT_TEXT_MAX_CHARS,
  makeFrame,
  type NodeFrameType,
  type NodeId,
  parseCoreFrame,
  type ThreadId,
  WS_CLOSE_CODES,
} from '@keith/protocol'
import { wsUrl } from './api.ts'
import { applyFrame, applyLocal, type ChatState, type ConnectionStatus, initialState } from './state.ts'

/**
 * The TUI's connection to the core: one WebSocket, `hello`, `thread.open` of the main thread,
 * frame handling through `@keith/protocol` parsers, heartbeat replies and reconnect with
 * exponential backoff. It holds the state and reports every change through `onState`.
 */

export const CAPABILITIES = ['chat.text@1']

export type Backoff = { initialMs: number; maxMs: number; factor: number }

export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 15_000, factor: 2 }

export type ChatClientDeps = {
  baseUrl: string
  token: string
  nodeId?: NodeId | undefined
  client: ClientInfo
  onState: (state: ChatState) => void
  /** Called when the core issues a new `nodeId`, so it can be persisted. */
  onNodeId?: ((nodeId: NodeId) => void) | undefined
  now?: (() => number) | undefined
  newId?: (() => string) | undefined
  backoff?: Backoff | undefined
  historyLimit?: number | undefined
  /** Timer used for reconnect delays. Returns a cancel function. */
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined
  signal?: AbortSignal | undefined
}

export type SendResult = { ok: true } | { ok: false; reason: 'empty' | 'too-long' | 'offline' }

export type ChatClient = {
  readonly state: ChatState
  start(): void
  /** Sends `input.text` to the open thread. */
  send(text: string): SendResult
  /** Sends `input.cancel` for the open thread. Returns false when there is nothing to cancel. */
  cancel(): boolean
  close(): void
}

/** Delay before reconnect attempt `attempt` (1-based). */
export function backoffDelay(backoff: Backoff, attempt: number): number {
  return Math.min(backoff.maxMs, Math.round(backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1)))
}

export function createChatClient(deps: ChatClientDeps): ChatClient {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const backoff = deps.backoff ?? DEFAULT_BACKOFF
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })

  let state = initialState()
  let socket: WebSocket | null = null
  let nodeId = deps.nodeId
  /** The thread to reopen after a reconnect. Unknown until the first `thread.opened`. */
  let threadId: ThreadId | undefined
  let attempt = 0
  let cancelTimer: (() => void) | null = null
  let stopped = false

  const update = (next: ChatState) => {
    state = next
    deps.onState(state)
  }
  const setConnection = (status: ConnectionStatus) =>
    update(applyLocal(state, { type: 'connection', status }))
  const notice = (level: 'info' | 'warn' | 'error', text: string) =>
    update(applyLocal(state, { type: 'notice', level, text }))

  const sendFrame = <T extends NodeFrameType>(type: T, data: FrameData<T>, re?: string): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const frame: FrameOf<T> = makeFrame(type, data, { id: newId(), ts: now(), re })
    socket.send(JSON.stringify(frame))
    return true
  }

  const connect = () => {
    if (stopped) return
    const ws = new WebSocket(wsUrl(deps.baseUrl, deps.token))
    socket = ws
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      sendFrame('hello', {
        protocol: 1,
        client: deps.client,
        capabilities: CAPABILITIES,
        ...(nodeId ? { nodeId } : {}),
      })
    })
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      // Binary frames carry audio (phase 3); the TUI declares no audio capability.
      if (typeof event.data !== 'string') return
      onText(event.data)
    })
    ws.addEventListener('close', (event) => {
      if (socket !== ws) return
      socket = null
      onClose(event.code, event.reason)
    })
    // An `error` event is always followed by `close`, which handles reconnecting.
  }

  const onText = (text: string) => {
    const result = parseCoreFrame(text)
    if (!result.ok) {
      if (result.code === 'UNSUPPORTED_PROTOCOL') {
        stop({ kind: 'closed', reason: 'the core speaks an unsupported protocol version' })
        return
      }
      // Unknown frame types are expected from newer cores and are ignored (additive changes).
      if (result.code === 'UNKNOWN_FRAME') return
      notice('warn', `ignored an invalid frame from the core (${result.message})`)
      return
    }
    onFrame(result.frame)
  }

  const onFrame = (frame: CoreFrame) => {
    switch (frame.type) {
      case 'ping':
        sendFrame('pong', {}, frame.id)
        return
      case 'welcome':
        attempt = 0
        if (frame.data.nodeId !== nodeId) {
          nodeId = frame.data.nodeId
          deps.onNodeId?.(frame.data.nodeId)
        }
        update(applyFrame(state, frame))
        sendFrame('thread.open', {
          ...(threadId ? { threadId } : {}),
          historyLimit: deps.historyLimit ?? DEFAULT_HISTORY_LIMIT,
        })
        return
      case 'thread.opened':
        threadId = frame.data.thread.id
        update(applyFrame(state, frame))
        return
      default:
        update(applyFrame(state, frame))
    }
  }

  const onClose = (code: number, reason: string) => {
    if (stopped) return
    if (code === WS_CLOSE_CODES.invalidToken) {
      stop({ kind: 'auth-required' })
      return
    }
    if (code === WS_CLOSE_CODES.unsupportedProtocol) {
      stop({ kind: 'closed', reason: reason || 'protocol version not supported' })
      return
    }
    attempt += 1
    const inMs = backoffDelay(backoff, attempt)
    setConnection({ kind: 'reconnecting', attempt, inMs })
    cancelTimer = schedule(() => {
      cancelTimer = null
      if (stopped) return
      setConnection({ kind: 'connecting' })
      connect()
    }, inMs)
  }

  const stop = (status: ConnectionStatus) => {
    stopped = true
    cancelTimer?.()
    cancelTimer = null
    const ws = socket
    socket = null
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000, 'client closed')
    setConnection(status)
  }

  deps.signal?.addEventListener('abort', () => stop({ kind: 'closed', reason: 'aborted' }), { once: true })

  return {
    get state() {
      return state
    },
    start() {
      if (stopped || socket) return
      setConnection({ kind: 'connecting' })
      connect()
    },
    send(text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return { ok: false, reason: 'empty' }
      if (trimmed.length > INPUT_TEXT_MAX_CHARS) return { ok: false, reason: 'too-long' }
      const thread = state.thread
      if (state.connection.kind !== 'online' || !thread) return { ok: false, reason: 'offline' }
      if (!sendFrame('input.text', { threadId: thread.id, text: trimmed }))
        return { ok: false, reason: 'offline' }
      update(applyLocal(state, { type: 'sent', text: trimmed }))
      return { ok: true }
    },
    cancel() {
      const thread = state.thread
      if (!thread || state.turnState === 'idle') return false
      return sendFrame('input.cancel', { threadId: thread.id })
    },
    close() {
      if (stopped) return
      stop({ kind: 'closed', reason: 'closed by user' })
    },
  }
}
