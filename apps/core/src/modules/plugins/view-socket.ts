import {
  type ClientToView,
  parseClientViewMessage,
  VIEW_LIMITS,
  VIEW_PROTOCOL_VERSION,
  type ViewCloseReason,
  type ViewToClient,
} from '@keith/contracts'
import type { ViewAccess, ViewHandle, ViewHost } from '@keith/host/views'
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import type { Via } from '../auth/index.ts'
import type { ViewAudit } from './view-audit.ts'

/**
 * Per-socket state kept by Bun (`server.upgrade({ data })`). The credential is not here: only `stillAllowed`,
 * a closure that asks the core whether this connection may still view, and the plain facts the host needs.
 */
export interface ViewSocketData {
  kind: 'view'
  principalId: string
  method: string | null
  /** Re-resolves the credential behind the socket now: false once it is revoked, expired or its person is not active. */
  stillAllowed(): Promise<boolean>
  /** How the viewer came (the audit rows say it). */
  via: Via
  /** A person's key or resize: the local socket counts it as activity for its idle-lock. */
  activity?(): void
  state: ViewConnState
}

interface ViewConnState {
  phase: 'hello' | 'opening' | 'open' | 'closed'
  helloTimer?: ReturnType<typeof setTimeout>
  view?: ViewHandle
  viewId?: string
  /** When `ready` was sent: the audit's `plugin.view.close` says how long the view lived. */
  openedAt?: number
  /** `ready` has been sent: frames may follow. */
  ready: boolean
  /** The newest frame that could not go out yet (before `ready`, or while the socket is backed up). Replaced, never queued. */
  held?: { seq: number; text: string }
  heldSince?: number
  lastSeen: number
  windowStart: number
  windowCount: number
  /** A `close` came while the view was still opening. */
  closeRequested: boolean
}

export interface ViewGatewayOptions {
  views: ViewHost
  access: Pick<ViewAccess, 'find'>
  /** The principal of an upgrade request: the same resolution as HTTP (bearer through the resolver). */
  authenticate(
    request: Request,
    ip: string | undefined,
    via: Via,
  ): Promise<
    | {
        principalId: string
        method: string | null
        stillAllowed(): Promise<boolean>
        activity?(): void
      }
    | undefined
  >
  warn?: (message: string) => void
  /** `plugin.view.open` and `plugin.view.close` (ids and reasons only), rate limited by the caller's `createViewAudit`. */
  audit?: ViewAudit
  /** Views one person may open per window (default 30 per minute); the next is `closed { reason: 'limit' }`. */
  opensPerWindow?: { max: number; windowMs: number }
  helloTimeoutMs?: number
  /** How often live views are re-checked (revoked or suspended viewer, silent peer, lagging peer). */
  sweepMs?: number
  /** A socket silent for this long is closed. */
  silentMs?: number
  /** A client that stays behind for this long is closed. */
  lagMs?: number
  /** Buffered bytes above which a new frame is held instead of sent. */
  bufferHighBytes?: number
  /** Messages per second per socket; beyond it the socket is closed. */
  messagesPerSecond?: number
}

export interface ViewGateway {
  /** `GET /plugins/views/ws`: authenticate, then upgrade. A `Response` means "not upgraded". */
  upgrade(request: Request, server: Server<unknown>, via?: Via): Promise<Response | undefined>
  websocket: WebSocketHandler<ViewSocketData>
  /** Open sockets (tests, doctor). */
  connections(): number
  /** Stop the sweeper and close every socket (the core stops). */
  close(): void
}

/** Largest message a view socket accepts: a 4096-character `key` with JSON overhead, with room to spare. */
export const VIEW_MESSAGE_MAX_BYTES = 64 * 1024

const refusal = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

type Socket = ServerWebSocket<ViewSocketData>

// a function, so a check after an await is not narrowed away by what was assigned before it
const isClosed = (state: ViewConnState): boolean => state.phase === 'closed'

/** Cut a frame into parts of at most `size` characters, never between the halves of a surrogate pair. */
export function chunkFrame(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const parts: string[] = []
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + size)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    parts.push(text.slice(at, end))
    at = end
  }
  return parts
}

/** The WebSocket side of plugin views (docs/specs/plugin-views.md, "Transport"). */
export function createViewGateway(options: ViewGatewayOptions): ViewGateway {
  const helloTimeoutMs = options.helloTimeoutMs ?? VIEW_LIMITS.helloTimeoutMs
  const sweepMs = options.sweepMs ?? 500
  const silentMs = options.silentMs ?? 60_000
  const lagMs = options.lagMs ?? 30_000
  const bufferHigh = options.bufferHighBytes ?? 128 * 1024
  const messagesPerSecond = options.messagesPerSecond ?? 400
  const sockets = new Set<Socket>()
  const openLimit = options.opensPerWindow ?? { max: 30, windowMs: 60_000 }
  const opens = new Map<string, number[]>()
  /** One more open for this person in the window; false once `max` is spent (the open is refused, nothing was started). */
  const mayOpen = (principalId: string): boolean => {
    const now = Date.now()
    const recent = (opens.get(principalId) ?? []).filter((t) => now - t < openLimit.windowMs)
    if (recent.length >= openLimit.max) {
      opens.set(principalId, recent)
      return false
    }
    recent.push(now)
    opens.set(principalId, recent)
    if (opens.size > 1000)
      for (const [k, v] of opens) if (v.every((t) => now - t >= openLimit.windowMs)) opens.delete(k)
    return true
  }
  let sweeper: ReturnType<typeof setInterval> | undefined
  let sweeping = false

  const send = (ws: Socket, message: ViewToClient): number => ws.send(JSON.stringify(message))

  /** One frame, in parts when it is long. Bun queues what the socket cannot take now: bounded by one frame. */
  const sendFrame = (ws: Socket, frame: { seq: number; text: string }): void => {
    const parts = chunkFrame(frame.text, VIEW_LIMITS.frameChunkChars)
    parts.forEach((text, i) => {
      send(ws, {
        type: 'frame',
        seq: frame.seq,
        text,
        ...(i < parts.length - 1 ? { more: true as const } : {}),
      })
    })
  }

  const deliver = (ws: Socket, frame: { seq: number; text: string }): void => {
    const state = ws.data.state
    if (state.phase === 'closed') return
    if (!state.ready || ws.getBufferedAmount() > bufferHigh) {
      // keep only the newest: nothing about a view buffers without bound
      state.held = frame
      state.heldSince ??= Date.now()
      return
    }
    delete state.held
    delete state.heldSince
    sendFrame(ws, frame)
  }

  const flushHeld = (ws: Socket): void => {
    const held = ws.data.state.held
    if (held !== undefined) deliver(ws, held)
  }

  /** End the connection: tell the client why, tear the view down, close the socket. */
  const finish = (ws: Socket, reason: ViewCloseReason): void => {
    const state = ws.data.state
    if (state.phase === 'closed') return
    state.phase = 'closed'
    clearTimeout(state.helloTimer)
    delete state.held
    try {
      send(ws, { type: 'closed', reason })
    } catch {
      // the peer is gone already
    }
    state.view?.close(reason)
    if (state.openedAt !== undefined && state.viewId !== undefined)
      options.audit?.closed(
        { principalId: ws.data.principalId, via: ws.data.via },
        state.viewId,
        reason,
        Date.now() - state.openedAt,
      )
    try {
      ws.close(1000, reason)
    } catch {
      // already closed
    }
  }

  const sweep = async (): Promise<void> => {
    if (sweeping) return
    sweeping = true
    try {
      const now = Date.now()
      await Promise.all(
        [...sockets].map(async (ws) => {
          const state = ws.data.state
          if (state.phase === 'closed') return
          if (now - state.lastSeen > silentMs) return finish(ws, 'error')
          if (state.heldSince !== undefined && now - state.heldSince > lagMs)
            return finish(ws, 'error')
          if (state.phase !== 'open') return
          const viewId = state.viewId
          let allowed = false
          try {
            allowed =
              (await ws.data.stillAllowed()) &&
              viewId !== undefined &&
              (await options.access.find(ws.data.principalId, viewId)) !== undefined
          } catch (error) {
            options.warn?.(
              `views: recheck failed: ${error instanceof Error ? error.message : error}`,
            )
            // fail closed
          }
          if (!allowed) finish(ws, 'revoked')
        }),
      )
    } finally {
      sweeping = false
    }
  }

  const track = (ws: Socket): void => {
    sockets.add(ws)
    sweeper ??= setInterval(() => void sweep(), sweepMs)
  }
  const untrack = (ws: Socket): void => {
    sockets.delete(ws)
    if (sockets.size === 0 && sweeper !== undefined) {
      clearInterval(sweeper)
      sweeper = undefined
    }
  }

  async function hello(
    ws: Socket,
    message: Extract<ClientToView, { type: 'hello' }>,
  ): Promise<void> {
    const state = ws.data.state
    state.phase = 'opening'
    clearTimeout(state.helloTimer)
    state.viewId = message.viewId
    if (!mayOpen(ws.data.principalId)) return finish(ws, 'limit')
    const result = await options.views.open(
      {
        viewer: { principalId: ws.data.principalId, method: ws.data.method },
        viewId: message.viewId,
        cols: message.cols,
        rows: message.rows,
        colorDepth: message.colorDepth,
        params: message.params,
      },
      {
        frame: (frame) => deliver(ws, frame),
        closed: (reason) => finish(ws, reason),
      },
    )
    if (isClosed(state)) {
      // the socket went away while the view opened
      if (result.ok) result.view.close('view')
      return
    }
    if (!result.ok) return finish(ws, result.reason)
    state.view = result.view
    if (state.closeRequested) return finish(ws, 'view')
    state.phase = 'open'
    state.openedAt = Date.now()
    options.audit?.opened({ principalId: ws.data.principalId, via: ws.data.via }, message.viewId)
    send(ws, { v: VIEW_PROTOCOL_VERSION, type: 'ready', cols: message.cols, rows: message.rows })
    state.ready = true
    flushHeld(ws)
  }

  return {
    async upgrade(request, server, via = 'tcp') {
      const who = await options.authenticate(
        request,
        via === 'local' ? 'local' : server.requestIP(request)?.address,
        via,
      )
      if (who === undefined) {
        return refusal(401, 'UNAUTHORIZED', 'missing, unknown or revoked credential')
      }
      const data: ViewSocketData = {
        kind: 'view',
        principalId: who.principalId,
        method: who.method,
        stillAllowed: who.stillAllowed,
        via,
        ...(who.activity === undefined ? {} : { activity: who.activity }),
        state: {
          phase: 'hello',
          ready: false,
          lastSeen: Date.now(),
          windowStart: 0,
          windowCount: 0,
          closeRequested: false,
        },
      }
      const upgraded = (server as Server<ViewSocketData>).upgrade(request, { data })
      return upgraded
        ? undefined
        : refusal(426, 'UPGRADE_REQUIRED', 'a WebSocket upgrade is required')
    },
    websocket: {
      maxPayloadLength: VIEW_MESSAGE_MAX_BYTES,
      open(ws) {
        track(ws)
        ws.data.state.helloTimer = setTimeout(() => {
          if (ws.data.state.phase === 'hello') finish(ws, 'refused')
        }, helloTimeoutMs)
      },
      message(ws, raw) {
        const state = ws.data.state
        if (state.phase === 'closed' || typeof raw !== 'string') return // binary is ignored
        const now = Date.now()
        state.lastSeen = now
        if (now - state.windowStart >= 1000) {
          state.windowStart = now
          state.windowCount = 0
        }
        if (++state.windowCount > messagesPerSecond) return finish(ws, 'error')
        if (raw.length > VIEW_MESSAGE_MAX_BYTES) return finish(ws, 'error')
        const parsed = parseClientViewMessage(raw)
        if (!parsed.ok) return finish(ws, state.phase === 'hello' ? 'refused' : 'error')
        const message = parsed.message
        if (message.type === 'ping') {
          send(ws, { type: 'pong' })
          return
        }
        if (state.phase === 'hello') {
          if (message.type !== 'hello') return finish(ws, 'refused')
          void hello(ws, message).catch((error: unknown) => {
            options.warn?.(`views: open failed: ${error instanceof Error ? error.message : error}`)
            finish(ws, 'error')
          })
          return
        }
        if (message.type === 'hello') return finish(ws, 'error') // a second hello
        if (message.type === 'close') {
          if (state.phase === 'opening') state.closeRequested = true
          else finish(ws, 'view')
          return
        }
        // key and resize reach a view that is open; while it opens they are dropped
        if (state.phase !== 'open' || state.view === undefined) return
        ws.data.activity?.()
        if (message.type === 'key') state.view.key(message.data)
        else if (message.type === 'resize') state.view.resize(message.cols, message.rows)
      },
      drain(ws) {
        flushHeld(ws)
      },
      close(ws) {
        const state = ws.data.state
        const wasClosed = state.phase === 'closed'
        state.phase = 'closed'
        clearTimeout(state.helloTimer)
        delete state.held
        untrack(ws)
        if (!wasClosed) {
          state.view?.close('view')
          if (state.openedAt !== undefined && state.viewId !== undefined)
            options.audit?.closed(
              { principalId: ws.data.principalId, via: ws.data.via },
              state.viewId,
              'disconnected',
              Date.now() - state.openedAt,
            )
        }
      },
    },
    connections: () => sockets.size,
    close() {
      for (const ws of [...sockets]) finish(ws, 'error')
      if (sweeper !== undefined) clearInterval(sweeper)
      sweeper = undefined
      sockets.clear()
    },
  }
}
