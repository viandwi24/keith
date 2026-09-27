// The HTTP + WS server on one port: `/v1/*` for the core, `/v1/ws` for nodes, everything else for
// plugin routes. See docs/contracts/protocol.md#transport.

import type { Server, ServerWebSocket } from 'bun'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { ThreadManager } from '../mind/types.ts'
import type { Clock, Ids, Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { VoiceInput } from '../voice/types.ts'
import type { ServerAttachmentRegistry } from './attachments.ts'
import { type AuthSession, createAuth } from './auth.ts'
import { type Connection, type ConnectionTiming, DEFAULT_TIMING, openConnection } from './connection.ts'
import { createFilesApi } from './files.ts'
import { createHttpApi, errorResponse, sessionOf } from './http-api.ts'
import { createPluginHttp, createPluginWs } from './plugin-routes.ts'
import type { ServerPresence } from './presence.ts'
import type { CoreServer } from './types.ts'

export type CoreServerDeps = {
  config: Pick<KeithConfig, 'server' | 'auth'>
  log: Logger
  clock: Clock
  ids: Ids
  events: CoreEventBus
  repos: Pick<Repositories, 'persons' | 'authTokens' | 'nodes' | 'threads' | 'messages' | 'files'>
  threads: ThreadManager
  attachments: ServerAttachmentRegistry
  presence: ServerPresence
  /** Keith's version, for `/v1/health` and `welcome`. */
  version: string
  /**
   * `KEITH_HOME/files` (`KeithPaths.filesDir`), where `/v1/files` keeps the bytes. Without it the
   * files endpoints answer `404 NOT_FOUND`.
   */
  filesDir?: string | undefined
  /** Tests shorten the handshake and heartbeat timers. */
  timing?: Partial<ConnectionTiming> | undefined
  /**
   * Phase 3: where node audio goes (`audio.start`, kind-1 binary frames, `audio.end`). Without it
   * audio frames get `error { INVALID_FRAME, "voice is not configured" }`.
   */
  voice?: VoiceInput | undefined
}

type WsData = { session: AuthSession | null; conn: Connection | null; done: Promise<void> | null }

export function createCoreServer(deps: CoreServerDeps): CoreServer {
  const log = deps.log.child({ component: 'server' })
  const auth = createAuth(deps)
  const http = createPluginHttp()
  const ws = createPluginWs()
  if (deps.filesDir === undefined) log.warn('no files directory: /v1/files is disabled')
  const files = createFilesApi({
    repos: deps.repos,
    ids: deps.ids,
    clock: deps.clock,
    log,
    dir: deps.filesDir ?? null,
  })
  const api = createHttpApi({
    auth,
    repos: deps.repos,
    threads: deps.threads,
    files,
    version: deps.version,
    log,
  })
  const timing: ConnectionTiming = { ...DEFAULT_TIMING, ...deps.timing }
  let frameSeq = 0
  const connectionDeps = {
    log: deps.log,
    clock: deps.clock,
    ids: deps.ids,
    events: deps.events,
    repos: deps.repos,
    threads: deps.threads,
    attachments: deps.attachments,
    presence: deps.presence,
    voice: deps.voice,
    pluginWs: ws,
    timing,
    server: { name: 'keith', version: deps.version },
    nextFrameId: () => `c${(++frameSeq).toString(36)}`,
  }
  const sockets = new Set<ServerWebSocket<WsData>>()
  let server: Server<WsData> | null = null

  const finish = (socket: ServerWebSocket<WsData>) => {
    sockets.delete(socket)
    socket.data.done ??= socket.data.conn?.closed() ?? Promise.resolve()
    return socket.data.done
  }

  const fetch = async (req: Request, srv: Server<WsData>): Promise<Response | undefined> => {
    const url = new URL(req.url)
    try {
      if (url.pathname === '/v1/ws') {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse('INVALID_REQUEST', 'expected a websocket upgrade')
        }
        const token = url.searchParams.get('token')
        const session = token ? await auth.resolve(token) : null
        if (srv.upgrade(req, { data: { session, conn: null, done: null } })) return undefined
        return errorResponse('INVALID_REQUEST', 'websocket upgrade failed')
      }
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return await api(req, url)
      const plugin = await http.handle(req, url, async (r) => {
        const s = await sessionOf(auth, r)
        return s ? { id: s.person.id, name: s.person.name, tier: s.person.tier } : null
      })
      return plugin ?? errorResponse('NOT_FOUND', `no route for ${req.method} ${url.pathname}`)
    } catch (error) {
      log.error('request failed', { method: req.method, path: url.pathname, error: String(error) })
      return errorResponse('INTERNAL', 'internal error')
    }
  }

  return {
    http,
    ws,
    async listen() {
      if (server) throw new Error('already listening')
      server = Bun.serve<WsData>({
        hostname: deps.config.server.host,
        port: deps.config.server.port,
        fetch,
        websocket: {
          open(socket) {
            sockets.add(socket)
            socket.data.conn = openConnection(
              connectionDeps,
              {
                sendText: (text) => socket.send(text),
                sendBinary: (bytes) => socket.sendBinary(bytes),
                close: (code, reason) => socket.close(code, reason),
              },
              socket.data.session,
            )
          },
          message(socket, message) {
            socket.data.conn?.message(message)
          },
          async close(socket) {
            await finish(socket)
          },
        },
      })
      const host = server.hostname ?? deps.config.server.host
      const port = server.port ?? deps.config.server.port
      log.info('server listening', { host, port })
      return { host, port }
    },
    async stop() {
      if (!server) return
      const open = [...sockets]
      for (const socket of open) socket.close(1001, 'server stopping')
      // Not awaited: in Bun 1.3.11 the promise of stop() never settles once a WebSocket has been
      // open on the server. stop(true) still stops listening and drops connections right away.
      server.stop(true).catch((error: unknown) => log.error('server stop failed', { error: String(error) }))
      server = null
      await Promise.all(open.map(finish))
    },
  }
}
