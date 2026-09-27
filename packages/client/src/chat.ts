import {
  type ClientInfo,
  type CoreFrame,
  DEFAULT_HISTORY_LIMIT,
  type FrameData,
  type FrameOf,
  INPUT_TEXT_MAX_CHARS,
  isPrefixedId,
  MESSAGES_PAGE,
  makeFrame,
  type NodeFrameType,
  type NodeId,
  parseCoreFrame,
  type ThreadId,
  UI_BLOCK_ID_PATTERN,
  WS_CLOSE_CODES,
} from '@keith/protocol'
import { ClientError } from './errors.ts'
import { type Fetch, listMessages, wsUrl } from './http.ts'
import {
  applyFrame,
  applyLocal,
  type ChatState,
  type ConnectionStatus,
  initialState,
  oldestMessageId,
} from './state.ts'

/**
 * A node's live connection to the core: one standard `WebSocket`, `hello`, `thread.open` of the
 * main thread, frame handling through `@keith/protocol` parsers, heartbeat replies and reconnect
 * with exponential backoff. It holds a `ChatState` and reports every change through `onState`.
 * Runs in Bun and in browsers (no `bun:*` / `node:*` imports).
 */

export const DEFAULT_CAPABILITIES: readonly string[] = ['chat.text@1']

export type Backoff = { initialMs: number; maxMs: number; factor: number }

export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 15_000, factor: 2 }

export type ChatClientDeps = {
  /** Normalized base URL (see `normalizeBaseUrl`). */
  baseUrl: string
  token: string
  /** The node id from an earlier `welcome`, so the core recognizes this device. */
  nodeId?: NodeId | undefined
  /** Describes the software in `hello`, e.g. `{ name: 'keith-tui', version }`. */
  client: ClientInfo
  /** Declared in `hello`. Default `['chat.text@1']`; a UI-capable node adds `ui.render@1`. */
  capabilities?: readonly string[] | undefined
  onState: (state: ChatState) => void
  /** Called when the core issues a new `nodeId`, so it can be persisted. */
  onNodeId?: ((nodeId: NodeId) => void) | undefined
  /** Used by `loadOlder`. Defaults to the global `fetch`. */
  fetch?: Fetch | undefined
  now?: (() => number) | undefined
  newId?: (() => string) | undefined
  backoff?: Backoff | undefined
  /** Messages `thread.open` asks for (0..200, default 50). */
  historyLimit?: number | undefined
  /** Messages per `loadOlder` page (1..200, default 50). */
  historyPageSize?: number | undefined
  /** Timer used for reconnect delays. Returns a cancel function. */
  schedule?: ((fn: () => void, ms: number) => () => void) | undefined
  signal?: AbortSignal | undefined
}

export type SendResult = { ok: true } | { ok: false; reason: 'empty' | 'too-long' | 'offline' }

export type UiActionInput = {
  /** The message the `actions` block belongs to. */
  messageId: string
  blockId: string
  actionId: string
  value?: unknown
}

export type UiActionResult = { ok: true } | { ok: false; reason: 'invalid' | 'offline' }

export type LoadOlderResult =
  | { ok: true; added: number }
  | { ok: false; reason: 'no-thread' | 'no-more' | 'busy' | 'failed'; error?: ClientError | undefined }

export type ChatClient = {
  readonly state: ChatState
  /** Connects. Does nothing when already started or closed. */
  start(): void
  /** Sends `input.text` to the open thread and shows it at once as a local entry. */
  send(text: string): SendResult
  /** Sends `input.cancel` for the open thread. Returns false when there is nothing to cancel. */
  cancel(): boolean
  /** Sends `ui.action` for a button of an `actions` block (nodes with `ui.render@1`). */
  sendUiAction(action: UiActionInput): UiActionResult
  /** Fetches the page of history before the oldest shown message and prepends it. */
  loadOlder(): Promise<LoadOlderResult>
  /**
   * Connects again now, keeping the state and the open thread. Pass a new token after
   * `auth-required` (close 4003) and a fresh login. Also skips a pending backoff delay.
   * Does nothing after `close()`.
   */
  reconnect(token?: string): void
  /** Closes for good. */
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
  const historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const capabilities = [...(deps.capabilities ?? DEFAULT_CAPABILITIES)]
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })

  let state = initialState()
  let token = deps.token
  let socket: WebSocket | null = null
  let nodeId = deps.nodeId
  /** The thread to reopen after a reconnect. Unknown until the first `thread.opened`. */
  let threadId: ThreadId | undefined
  let attempt = 0
  let cancelTimer: (() => void) | null = null
  /** Not connected and not reconnecting on its own (auth-required, or closed). */
  let stopped = false
  /** `close()`, 4009 or an abort: nothing restarts it. */
  let closed = false

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
    const ws = new WebSocket(wsUrl(deps.baseUrl, token))
    socket = ws
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      sendFrame('hello', {
        protocol: 1,
        client: deps.client,
        capabilities,
        ...(nodeId ? { nodeId } : {}),
      })
    })
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      // Binary frames carry audio (phase 3); this client declares no audio capability.
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
        stop({ kind: 'closed', reason: 'the core speaks an unsupported protocol version' }, true)
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
        sendFrame('thread.open', { ...(threadId ? { threadId } : {}), historyLimit })
        return
      case 'thread.opened': {
        threadId = frame.data.thread.id
        const next = applyFrame(state, frame)
        const hasMore = frame.data.messages.length >= historyLimit
        update(applyLocal(next, { type: 'history', history: { hasMore, loading: false } }))
        return
      }
      default:
        update(applyFrame(state, frame))
    }
  }

  const onClose = (code: number, reason: string) => {
    if (stopped) return
    if (code === WS_CLOSE_CODES.invalidToken) {
      stop({ kind: 'auth-required' }, false)
      return
    }
    if (code === WS_CLOSE_CODES.unsupportedProtocol) {
      stop({ kind: 'closed', reason: reason || 'protocol version not supported' }, true)
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

  const dropSocket = () => {
    cancelTimer?.()
    cancelTimer = null
    const ws = socket
    socket = null
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000, 'client closed')
  }

  const stop = (status: ConnectionStatus, forGood: boolean) => {
    stopped = true
    if (forGood) closed = true
    dropSocket()
    setConnection(status)
  }

  deps.signal?.addEventListener('abort', () => stop({ kind: 'closed', reason: 'aborted' }, true), {
    once: true,
  })

  const isOnline = () => state.connection.kind === 'online' && state.thread !== null

  return {
    get state() {
      return state
    },
    start() {
      if (closed || stopped || socket || cancelTimer) return
      setConnection({ kind: 'connecting' })
      connect()
    },
    send(text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return { ok: false, reason: 'empty' }
      if (trimmed.length > INPUT_TEXT_MAX_CHARS) return { ok: false, reason: 'too-long' }
      const thread = state.thread
      if (!isOnline() || !thread) return { ok: false, reason: 'offline' }
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
    sendUiAction(action) {
      const { messageId, blockId, actionId } = action
      if (
        !isPrefixedId('msg', messageId) ||
        !UI_BLOCK_ID_PATTERN.test(blockId) ||
        !UI_BLOCK_ID_PATTERN.test(actionId)
      ) {
        return { ok: false, reason: 'invalid' }
      }
      const thread = state.thread
      if (!isOnline() || !thread) return { ok: false, reason: 'offline' }
      const data = {
        threadId: thread.id,
        messageId,
        blockId,
        actionId,
        ...('value' in action ? { value: action.value } : {}),
      }
      return sendFrame('ui.action', data) ? { ok: true } : { ok: false, reason: 'offline' }
    },
    async loadOlder() {
      const thread = state.thread
      if (!thread) return { ok: false, reason: 'no-thread' }
      if (state.history.loading) return { ok: false, reason: 'busy' }
      if (!state.history.hasMore) return { ok: false, reason: 'no-more' }
      const before = oldestMessageId(state)
      update(applyLocal(state, { type: 'history', history: { ...state.history, loading: true } }))
      try {
        const page = await listMessages(
          deps.baseUrl,
          token,
          thread.id,
          {
            ...(before && isPrefixedId('msg', before) ? { before } : {}),
            limit: deps.historyPageSize ?? MESSAGES_PAGE.defaultLimit,
          },
          { fetch: deps.fetch },
        )
        // The thread may have changed while the page was loading.
        if (state.thread?.id !== thread.id) return { ok: false, reason: 'no-thread' }
        const count = state.entries.length
        update(applyLocal(state, { type: 'history.page', messages: page.messages, hasMore: page.hasMore }))
        return { ok: true, added: state.entries.length - count }
      } catch (error) {
        if (!(error instanceof ClientError)) throw error
        update(applyLocal(state, { type: 'history', history: { ...state.history, loading: false } }))
        notice('error', `cannot load older messages: ${error.message}`)
        return { ok: false, reason: 'failed', error }
      }
    },
    reconnect(newToken) {
      if (closed) return
      if (newToken !== undefined) token = newToken
      stopped = false
      attempt = 0
      dropSocket()
      setConnection({ kind: 'connecting' })
      connect()
    },
    close() {
      if (closed) return
      stop({ kind: 'closed', reason: 'closed by user' }, true)
    },
  }
}
