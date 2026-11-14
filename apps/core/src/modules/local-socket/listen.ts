import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server, WebSocketHandler } from 'bun'
import { SOCKET_PATH_FILE, socketPathFor } from './path.ts'

/** Whether something answers HTTP on the socket (any response counts). */
export async function probeSocket(path: string, timeoutMs = 800): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    await fetch('http://localhost/health', {
      unix: path,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit)
    return true
  } catch {
    return false
  }
}

export class CoreAlreadyRunning extends Error {
  constructor(path: string) {
    super(`core already running (something answers on ${path})`)
    this.name = 'CoreAlreadyRunning'
  }
}

export interface LocalListener {
  path: string
  /** Stop listening and remove the socket file. */
  stop(): Promise<void>
}

export interface LocalListenOptions {
  dataDir: string
  /** Requests of the socket: `core.fetchLocal`. */
  fetch: (
    request: Request,
    server: Server<undefined>,
  ) => Response | undefined | Promise<Response | undefined>
  /** The WebSocket handler (`core.websocket`): only the plugin view upgrade reaches it from this socket. */
  websocket?: WebSocketHandler<never>
  /**
   * Bun's idle timeout in seconds, as on the TCP server (`SERVER_LIMITS`): a connection that sends nothing for this long is
   * closed. An authorized request lifts it for its own lifetime (`core.fetchLocal` keeps it open, as `createCore.fetch` does).
   * Bun's default (10 s) applies when it is not given.
   */
  idleTimeout?: number
  /** Body cap (the same cap as the TCP server). */
  maxRequestBodySize?: number
  /** Socket path override (tests). */
  path?: string
}

/**
 * Serve the core on the owner-only Unix socket. A stale file (nothing answers) is removed; a live
 * one refuses the start. The file is made 0600 after listen (the umask already makes it so).
 */
export async function listenLocal(options: LocalListenOptions): Promise<LocalListener> {
  const path = options.path ?? socketPathFor(options.dataDir)
  if (existsSync(path)) {
    if (await probeSocket(path)) throw new CoreAlreadyRunning(path)
    rmSync(path, { force: true })
  }
  const server = Bun.serve({
    unix: path,
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    fetch: (request: Request, srv: Server<undefined>) => options.fetch(request, srv),
    // the one WebSocket handler of the core (`ws.data.kind` picks the owner); typed loosely: Bun ties `data` to `upgrade`
    ...(options.websocket === undefined ? {} : { websocket: options.websocket }),
  } as Parameters<typeof Bun.serve>[0]) as Server<undefined>
  chmodSync(path, 0o600)
  const pathFile = join(options.dataDir, SOCKET_PATH_FILE)
  const recorded = options.path === undefined && path !== join(options.dataDir, 'core.sock')
  if (recorded) writeFileSync(pathFile, `${path}\n`, { mode: 0o600 })
  return {
    path,
    async stop() {
      await server.stop(true)
      rmSync(path, { force: true })
      if (recorded) rmSync(pathFile, { force: true })
    },
  }
}
