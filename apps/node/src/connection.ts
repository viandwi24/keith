import {
  type CoreToNode,
  type Invoke,
  type NodeCancel,
  type NodeManifest,
  type NodeToCore,
  PROTOCOL_VERSION,
  parseCoreMessage,
  type Rotate,
  type Welcome,
} from '@keith/contracts'
import type { Logger } from './platform/logger.ts'

/** `revoked`: core refused this token for good (close 4003, or 401 at connect); no reconnect. */
export type ConnectionState = 'idle' | 'connecting' | 'online' | 'backoff' | 'stopped' | 'revoked'

/** Close code core sends when it revokes a node (`registry.revoke`). */
export const REVOKED_CLOSE_CODE = 4003

/** The slice of the WebSocket API the connection needs. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike

/** Status of a plain request to the socket address; `401` means core refused the token. */
export type Probe = (url: string, headers: Record<string, string>) => Promise<number>

export interface Clock {
  now(): number
  /** Returns a function that cancels the timer. */
  setTimeout(fn: () => void, ms: number): () => void
  setInterval(fn: () => void, ms: number): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
  setInterval(fn, ms) {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
}

/** Bun's native WebSocket accepts `headers` in its constructor options. */
export const bunSocketFactory: SocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers } as unknown as string[])
  return ws as unknown as SocketLike
}

/**
 * A plain `GET` of the socket address with the same bearer header. A Bun WebSocket does not expose
 * the status of a failed upgrade, so this is how a token refused at connect (401) is told apart
 * from a core that is down (F-033).
 */
export const httpProbe: Probe = async (url, headers) => {
  const target = new URL(url)
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  const response = await fetch(target, { headers })
  await response.body?.cancel()
  return response.status
}

export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 30_000
/** Core must answer `hello` with `welcome` within this time. */
export const WELCOME_TIMEOUT_MS = 10_000

export interface ConnectionOptions {
  url: string
  token: string
  manifest: NodeManifest
  logger: Logger
  socketFactory?: SocketFactory
  /** Status probe for a socket that never opened (default: `httpProbe`). */
  probe?: Probe
  clock?: Clock
  /** In [0, 1); injectable so tests are deterministic. */
  random?: () => number
  onInvoke(message: Invoke): void
  onCancel(message: NodeCancel): void
  /** The socket went away (or was closed); running calls must stop. */
  onDrop(): void
  /** Core answered `welcome` with `accepted: false`; the connection stops for good. */
  onRefused(reason: string): void
  /** The token is revoked: the connection stops for good and must not retry. */
  onRevoked?(reason: string): void
  /**
   * Stores a token core handed out (`rotate`). The file must hold the token when this resolves;
   * without this callback the node never accepts a new token.
   */
  persistToken?: (token: string) => Promise<void>
  onState?(state: ConnectionState): void
}

export interface Connection {
  readonly state: ConnectionState
  /** Increases on every new socket; lets callers drop results that belong to an older socket. */
  readonly epoch: number
  start(): void
  stop(): void
  /** False when there is no open socket. */
  send(message: NodeToCore): boolean
}

/** Backoff delay for attempt n (0-based): 1 s doubling to 30 s, then +-20% jitter. */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
  return Math.round(base * (0.8 + 0.4 * random))
}

export function createConnection(options: ConnectionOptions): Connection {
  const factory = options.socketFactory ?? bunSocketFactory
  const probe = options.probe ?? httpProbe
  const clock = options.clock ?? realClock
  const random = options.random ?? Math.random
  const { logger } = options
  /** The token the next socket uses: the configured one until a rotation stores a new one. */
  let token = options.token

  let state: ConnectionState = 'idle'
  let epoch = 0
  let attempt = 0
  let socket: SocketLike | null = null
  let open = false
  let cancelHeartbeat: (() => void) | null = null
  let cancelWelcomeTimer: (() => void) | null = null
  let cancelBackoff: (() => void) | null = null

  const setState = (next: ConnectionState): void => {
    if (state === next) return
    state = next
    options.onState?.(next)
  }

  const clearTimers = (): void => {
    cancelHeartbeat?.()
    cancelWelcomeTimer?.()
    cancelHeartbeat = cancelWelcomeTimer = null
  }

  const send = (message: NodeToCore): boolean => {
    if (!socket || !open) return false
    socket.send(JSON.stringify(message))
    return true
  }

  function handleWelcome(welcome: Welcome): void {
    cancelWelcomeTimer?.()
    cancelWelcomeTimer = null
    if (!welcome.accepted) {
      const reason = welcome.reason ?? 'refused by core'
      setState('stopped')
      detach()
      options.onRefused(reason)
      return
    }
    attempt = 0
    setState('online')
    cancelHeartbeat = clock.setInterval(() => {
      send({ v: PROTOCOL_VERSION, type: 'heartbeat', at: clock.now() })
    }, welcome.heartbeatMs)
  }

  function handleMessage(raw: unknown): void {
    const parsed = parseCoreMessage(raw)
    if (!parsed.ok) {
      logger.warn(`ignoring bad message from core: ${parsed.error}`)
      return
    }
    const message: CoreToNode = parsed.message
    if (message.type === 'welcome') handleWelcome(message)
    else if (state !== 'online') logger.warn(`ignoring ${message.type} before welcome`)
    else if (message.type === 'invoke') options.onInvoke(message)
    else if (message.type === 'rotate') handleRotate(message)
    else options.onCancel(message)
  }

  /**
   * Core handed out a new token: store it, then answer `rotated` and reconnect with it. A failed
   * store keeps the old token and sends nothing, so core keeps the old one and offers again later.
   */
  function handleRotate(message: Rotate): void {
    const persist = options.persistToken
    if (persist === undefined) {
      logger.warn('core sent a new token, but this node cannot store it: keeping the current one')
      return
    }
    const current = socket
    persist(message.token).then(
      () => {
        // the stored file has the new token from here on, whatever happens to this socket
        token = message.token
        if (socket !== current || state !== 'online') return
        send({ v: PROTOCOL_VERSION, type: 'rotated' })
        logger.info('token rotated: reconnecting with the new token')
        detach()
        options.onDrop()
        connect()
      },
      (error: unknown) =>
        logger.error(
          `could not store the new token, keeping the current one: ${error instanceof Error ? error.message : String(error)}`,
        ),
    )
  }

  /** Forget the current socket and close it; its late events are ignored. */
  function detach(): void {
    clearTimers()
    const old = socket
    socket = null
    open = false
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close(1000)
      } catch {
        // already closed
      }
    }
  }

  /** Stopped for good: by a refused welcome, by a revocation or by `stop()`. */
  const isDone = (): boolean => state === 'stopped' || state === 'revoked'

  function revoke(reason: string): void {
    if (isDone()) return
    cancelBackoff?.()
    cancelBackoff = null
    setState('revoked')
    detach()
    options.onDrop()
    options.onRevoked?.(reason)
  }

  function scheduleReconnect(): void {
    if (isDone()) return
    const delay = backoffDelay(attempt, random())
    attempt += 1
    setState('backoff')
    logger.info(`disconnected; reconnecting in ${delay} ms`)
    cancelBackoff = clock.setTimeout(() => {
      cancelBackoff = null
      connect()
    }, delay)
  }

  function onSocketLost(): void {
    detach()
    options.onDrop()
    scheduleReconnect()
  }

  /** The socket never opened: ask core with a plain request whether the token is still valid. */
  function onFailedOpen(): void {
    detach()
    options.onDrop()
    probe(options.url, { Authorization: `Bearer ${token}` }).then(
      (status) => {
        if (isDone()) return
        if (status === 401) revoke('core refused the node token (revoked or unknown)')
        else scheduleReconnect()
      },
      () => {
        if (!isDone()) scheduleReconnect()
      },
    )
  }

  function connect(): void {
    if (isDone()) return
    epoch += 1
    setState('connecting')
    const ws = factory(options.url, { Authorization: `Bearer ${token}` })
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      open = true
      send({ v: PROTOCOL_VERSION, type: 'hello', manifest: options.manifest })
      cancelWelcomeTimer = clock.setTimeout(() => {
        logger.warn('no welcome from core in time')
        onSocketLost()
      }, WELCOME_TIMEOUT_MS)
    }
    ws.onmessage = (event) => {
      if (socket === ws) handleMessage(event.data)
    }
    ws.onclose = (event) => {
      if (socket !== ws) return
      if (event.code === REVOKED_CLOSE_CODE) revoke('revoked by core')
      else if (!open) onFailedOpen()
      else onSocketLost()
    }
    ws.onerror = () => {
      // A close event follows; the reconnect is scheduled there.
      logger.warn('socket error')
    }
  }

  return {
    get state() {
      return state
    },
    get epoch() {
      return epoch
    },
    start() {
      if (state !== 'idle') return
      connect()
    },
    stop() {
      if (isDone()) return
      setState('stopped')
      cancelBackoff?.()
      cancelBackoff = null
      const hadSocket = socket !== null
      detach()
      if (hadSocket) options.onDrop()
    },
    send,
  }
}
