import {
  type CoreToNode,
  HelloSchema,
  MIN_PROTOCOL,
  PROTOCOL_VERSION,
  parseNodeMessage,
  ROTATION_PROTOCOL,
} from '@keith/contracts'
import type { NodesRepo } from '@keith/db'
import type { Server, WebSocketHandler } from 'bun'
import { hashToken } from '../auth/index.ts'
import { newNodeToken } from './pairing.ts'
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  type RateLimit,
  type RateLimiter,
} from './rate-limit.ts'
import type { NodeHub } from './registry.ts'

/** A node token older than this is rotated at its next connection (ADR-0027 §28). */
export const NODE_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Per-socket state kept by Bun (`server.upgrade({ data })`). */
export interface NodeSocketData {
  /** Tells the socket dispatcher of `compose.ts` which handler owns the socket (absent counts as `node`). */
  kind?: 'node'
  nodeId: string
  welcomed: boolean
  helloTimer?: ReturnType<typeof setTimeout>
  /** Message budget of this socket, set at the welcome. */
  limiter?: RateLimiter
  /** Set once the socket is closed for overload: later messages are ignored. */
  overloadClosed?: boolean
  /** Hash of the token this socket handed out in a `rotate`, until the node answers `rotated`. */
  pendingHash?: string | undefined
}

export interface GatewayOptions {
  nodes: NodesRepo
  hub: NodeHub
  heartbeatMs: number
  /** A socket that does not say hello in this time is closed. */
  helloTimeoutMs?: number
  /** Message budget per node socket after the welcome (ADR-0027 §28). */
  rate?: Partial<RateLimit>
  /** Clock of the rate limit (tests). */
  now?: () => number
  /** A node went over its budget. Called at most once per `rate.auditEveryMs` per node. */
  onRateLimited?: (nodeId: string) => void
  /** Token older than this is rotated after the welcome (default 30 days). */
  rotateAfterMs?: number
  /** A token rotation completed: the node uses its new token. */
  onRotated?: (info: { nodeId: string; name: string }) => void
  warn?: (message: string) => void
}

export interface Gateway {
  /** `GET /nodes/ws`: authenticate, then upgrade. A `Response` means "not upgraded". */
  upgrade(request: Request, server: Server<NodeSocketData>): Promise<Response | undefined>
  websocket: WebSocketHandler<NodeSocketData>
}

const bearer = (header: string | null): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1]

const refusal = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** The WebSocket side of nodes (Bun's native `websocket` handler, ADR-0006). */
export function createGateway(options: GatewayOptions): Gateway {
  const { hub } = options
  const now = options.now ?? Date.now
  const rotateAfter = options.rotateAfterMs ?? NODE_TOKEN_MAX_AGE_MS
  const rate: RateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rate }
  /** Last `node.rate_limited` audit row per node (one row per `auditEveryMs`). */
  const lastRateAudit = new Map<string, number>()
  const send = (ws: { send(data: string): unknown }, message: CoreToNode): void => {
    ws.send(JSON.stringify(message))
  }
  const reject = (
    ws: {
      data: NodeSocketData
      send(data: string): unknown
      close(code?: number, reason?: string): void
    },
    reason: string,
  ): void => {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: 'welcome',
      accepted: false,
      nodeId: ws.data.nodeId,
      heartbeatMs: options.heartbeatMs,
      reason,
    })
    ws.close(4002, reason.slice(0, 120))
  }

  /** Completes a rotation whose new token (hash `hash`) is in use. A repeat changes nothing. */
  const commitRotation = (nodeId: string, hash: string): void => {
    const record = options.nodes.commitTokenRotation(nodeId, hash)
    if (record !== undefined) options.onRotated?.({ nodeId, name: record.name })
  }

  /** Hands the node a new token when its current one is older than `rotateAfter`. */
  const maybeRotate = async (ws: {
    data: NodeSocketData
    send(data: string): unknown
  }): Promise<void> => {
    const record = options.nodes.get(ws.data.nodeId)
    if (record === undefined || now() - record.tokenIssuedAt <= rotateAfter) return
    const token = newNodeToken()
    const hash = await hashToken(token)
    // a node revoked meanwhile gets nothing
    if (options.nodes.beginTokenRotation(ws.data.nodeId, hash) === undefined) return
    ws.data.pendingHash = hash
    send(ws, { v: PROTOCOL_VERSION, type: 'rotate', token })
  }

  return {
    async upgrade(request, server) {
      const token = bearer(request.headers.get('authorization'))
      const hash = token === undefined ? undefined : await hashToken(token)
      const node = hash === undefined ? undefined : options.nodes.findByTokenHash(hash)
      if (node === undefined || hash === undefined) {
        return refusal(401, 'UNAUTHORIZED', 'missing, unknown or revoked node token')
      }
      // presenting the pending token proves the node stored it: the rotation is complete
      commitRotation(node.id, hash)
      const upgraded = server.upgrade(request, {
        data: { kind: 'node', nodeId: node.id, welcomed: false },
      })
      return upgraded
        ? undefined
        : refusal(426, 'UPGRADE_REQUIRED', 'a WebSocket upgrade is required')
    },
    websocket: {
      maxPayloadLength: 4 * 1024 * 1024,
      open(ws) {
        ws.data.helloTimer = setTimeout(() => {
          if (!ws.data.welcomed) reject(ws, 'no hello received')
        }, options.helloTimeoutMs ?? 10_000)
      },
      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8')
        if (!ws.data.welcomed) {
          let value: unknown
          try {
            value = JSON.parse(text)
          } catch {
            return reject(ws, 'the first message must be a JSON hello')
          }
          const version = (value as { v?: unknown } | null)?.v
          if (typeof version === 'number' && version < MIN_PROTOCOL) {
            return reject(
              ws,
              `protocol version ${version} is below the minimum supported ${MIN_PROTOCOL}: update the node`,
            )
          }
          const hello = HelloSchema.safeParse(value)
          if (!hello.success) return reject(ws, `invalid hello: ${hello.error.message}`)
          if (!hub.connect(ws.data.nodeId, ws, hello.data.manifest)) {
            return reject(ws, 'this node is not paired (any more)')
          }
          ws.data.welcomed = true
          ws.data.limiter = createRateLimiter(rate, now)
          clearTimeout(ws.data.helloTimer)
          send(ws, {
            v: PROTOCOL_VERSION,
            type: 'welcome',
            accepted: true,
            nodeId: ws.data.nodeId,
            heartbeatMs: options.heartbeatMs,
          })
          if (hello.data.v >= ROTATION_PROTOCOL) {
            maybeRotate(ws).catch((error: unknown) =>
              options.warn?.(
                `node ${ws.data.nodeId}: could not start a token rotation: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          }
          return
        }
        if (ws.data.overloadClosed) return
        const limiter = ws.data.limiter
        if (limiter !== undefined && !limiter.admit()) {
          const nodeId = ws.data.nodeId
          const last = lastRateAudit.get(nodeId)
          if (last === undefined || now() - last >= rate.auditEveryMs) {
            lastRateAudit.set(nodeId, now())
            options.onRateLimited?.(nodeId)
          }
          if (limiter.overloaded()) {
            ws.data.overloadClosed = true
            options.warn?.(`node ${nodeId}: over its message budget for a long time, closing`)
            ws.close(4008, 'message rate limit')
          }
          return
        }
        const parsed = parseNodeMessage(text)
        if (!parsed.ok) {
          options.warn?.(`node ${ws.data.nodeId}: ignored a bad message: ${parsed.error}`)
          return
        }
        if (parsed.message.type === 'rotated') {
          const pending = ws.data.pendingHash
          ws.data.pendingHash = undefined
          if (pending === undefined)
            options.warn?.(`node ${ws.data.nodeId}: rotated without a rotate`)
          else commitRotation(ws.data.nodeId, pending)
          return
        }
        hub.receive(ws.data.nodeId, parsed.message)
      },
      close(ws) {
        clearTimeout(ws.data.helloTimer)
        hub.disconnect(ws.data.nodeId, ws)
      },
    },
  }
}
