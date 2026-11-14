import {
  parseServerViewMessage,
  RESERVED_VIEW_KEYS,
  VIEW_LIMITS,
  VIEW_PROTOCOL_VERSION,
  type ViewCloseReason,
} from '@keith/contracts'
import { type ParsedFrame, parseFrame } from './parse-frame.ts'

/** How a view ended: the server's reason, or what the client saw. */
export type ViewEndReason =
  | ViewCloseReason
  /** The connection dropped or went silent after it had opened: the server tore the view down. */
  | 'disconnected'
  /** The socket never opened (core down, bad URL, a refused upgrade such as a bad credential). */
  | 'unavailable'
  /** The server sent something the protocol does not allow. */
  | 'protocol'

export type ViewStatus = 'connecting' | 'open' | 'closed'

/** The minimal WebSocket the client needs: the platform `WebSocket` fits, and tests pass a fake. */
export interface ViewSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}
export type ViewConnector = (url: string, headers: Record<string, string>) => ViewSocket

/** Bun's `WebSocket` takes request headers: the bearer goes in a header, never in the URL. */
const defaultConnector: ViewConnector = (url, headers) =>
  new WebSocket(url, { headers } as never) as unknown as ViewSocket

export interface OpenViewOptions {
  /** Base URL of the core (`http://127.0.0.1:4100`); `/plugins/views/ws` is added. */
  core: string
  /** The person's bearer credential. It is sent in a header and never kept beyond this call. None on the local socket. */
  credential?: string
  /** Connect over this Unix socket (`ws+unix`) instead of TCP; the socket's own rules decide who the viewer is. */
  socketPath?: string
  /** `<plugin>.<view>` from the menu. */
  viewId: string
  cols: number
  rows: number
  colorDepth?: 1 | 4 | 8 | 24
  params?: Record<string, string>
  /** Each complete frame, parsed and sanitised (`parseFrame`), already cut to the size and colour depth. */
  onFrame(frame: ParsedFrame): void
  /** `connecting`, then `open` after the server's `ready`, then `closed`. */
  onStatus?(status: ViewStatus): void
  /** Exactly once, when the view is over, with the reason. */
  onEnd(reason: ViewEndReason): void
  /** Tests only. */
  connect?: ViewConnector
  /** Heartbeat (default 20 s) and the silence after which the server counts as gone (default 60 s). */
  pingMs?: number
  silentMs?: number
  /** After `close()`, how long to wait for the server's answer before dropping the socket (default 1 s). */
  closeWaitMs?: number
  /** A resize is sent this long after the last one (default 50 ms). */
  resizeMs?: number
}

export interface ViewConnection {
  status(): ViewStatus
  /** Terminal input bytes (an arrow up is `ESC [ A`). The reserved keys are dropped here, a paste is split. */
  sendKey(data: string): void
  /** New size, coalesced; ignored until the view is open. */
  resize(cols: number, rows: number): void
  /** Leave. The server tears the view down; `onEnd('view')` follows. */
  close(): void
}

/** A paste is cut at this many characters. */
export const PASTE_MAX = 64 * 1024

const viewUrl = (core: string, socketPath?: string): string => {
  if (socketPath !== undefined) return `ws+unix://${socketPath}:/plugins/views/ws`
  const url = new URL('/plugins/views/ws', core)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * Open a plugin terminal view (docs/specs/plugin-views.md). **Reconnect rules:** there are none. A view lives on the server
 * only while its socket is open (the server tears it down when the socket drops), so a dropped connection is a view that
 * is gone: the client reports `onEnd('disconnected')` and the UI offers to open a fresh one on the person's action. It
 * never reconnects behind their back, and never replays input.
 */
export function openView(options: OpenViewOptions): ViewConnection {
  const connect = options.connect ?? defaultConnector
  const pingMs = options.pingMs ?? 20_000
  const silentMs = options.silentMs ?? 60_000
  const closeWaitMs = options.closeWaitMs ?? 1_000
  const resizeMs = options.resizeMs ?? 50
  const depth = options.colorDepth ?? 24

  let status: ViewStatus = 'connecting'
  let ended = false
  let closing = false
  let opened = false
  let socketOpen = false
  let size = { cols: options.cols, rows: options.rows }
  let lastSeen = Date.now()
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let lastSeq = -1
  let partial: { seq: number; text: string } | undefined

  const setStatus = (next: ViewStatus): void => {
    if (status === next) return
    status = next
    options.onStatus?.(next)
  }
  options.onStatus?.('connecting')

  const socket = connect(
    viewUrl(options.core, options.socketPath),
    options.credential === undefined ? {} : { authorization: `Bearer ${options.credential}` },
  )

  const finish = (reason: ViewEndReason): void => {
    if (ended) return
    ended = true
    clearInterval(pingTimer)
    clearTimeout(closeTimer)
    clearTimeout(resizeTimer)
    partial = undefined
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try {
      socket.close()
    } catch {
      // already closed
    }
    setStatus('closed')
    options.onEnd(reason)
  }
  const send = (message: unknown): void => {
    if (ended) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      finish('disconnected')
    }
  }

  socket.onopen = () => {
    socketOpen = true
    lastSeen = Date.now()
    send({
      v: VIEW_PROTOCOL_VERSION,
      type: 'hello',
      viewId: options.viewId,
      cols: size.cols,
      rows: size.rows,
      colorDepth: depth,
      ...(options.params === undefined ? {} : { params: options.params }),
    })
    pingTimer = setInterval(() => {
      if (Date.now() - lastSeen > silentMs) return finish('disconnected')
      send({ type: 'ping' })
    }, pingMs)
  }
  socket.onerror = () => {
    // `onclose` follows and decides the reason
  }
  socket.onclose = () => finish(closing ? 'view' : opened ? 'disconnected' : 'unavailable')
  socket.onmessage = (event) => {
    if (ended || typeof event.data !== 'string') return // binary is ignored
    lastSeen = Date.now()
    const parsed = parseServerViewMessage(event.data)
    if (!parsed.ok) return finish('protocol')
    const message = parsed.message
    if (message.type === 'ready') {
      opened = true
      if (!closing) setStatus('open')
      return
    }
    if (message.type === 'pong') return
    if (message.type === 'closed') return finish(closing ? 'view' : message.reason)
    // a frame, or one part of it
    if (message.seq < lastSeq || (partial !== undefined && message.seq < partial.seq)) return // stale
    if (partial !== undefined && partial.seq !== message.seq) partial = undefined // a newer frame replaces an unfinished one
    const text = (partial?.text ?? '') + message.text
    if (text.length > VIEW_LIMITS.frameMaxBytes) return finish('protocol')
    if (message.more === true) {
      partial = { seq: message.seq, text }
      return
    }
    partial = undefined
    lastSeq = message.seq
    options.onFrame(parseFrame(text, { cols: size.cols, rows: size.rows, colorDepth: depth }))
  }

  return {
    status: () => status,
    sendKey(data) {
      if (status !== 'open' || closing || data === '') return
      if (data === RESERVED_VIEW_KEYS.leave || data === RESERVED_VIEW_KEYS.home) return
      const text = data.length > PASTE_MAX ? data.slice(0, PASTE_MAX) : data
      for (let at = 0; at < text.length; ) {
        let end = Math.min(text.length, at + VIEW_LIMITS.keyMaxChars)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end-- // not between the halves of a pair
        send({ type: 'key', data: text.slice(at, end) })
        at = end
      }
    },
    resize(cols, rows) {
      size = { cols, rows }
      if (status !== 'open' || closing) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => send({ type: 'resize', ...size }), resizeMs)
    },
    close() {
      if (ended || closing) return
      closing = true
      if (!socketOpen) return finish('view') // nothing was said yet: just drop it
      send({ type: 'close' })
      closeTimer = setTimeout(() => finish('view'), closeWaitMs)
    },
  }
}
