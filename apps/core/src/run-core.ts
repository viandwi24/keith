import { join } from 'node:path'
import { type Core, type CoreOptions, createCore } from './compose.ts'
import { acquireLock, type FileLock, LOCK_FILE, LockHeldError } from './modules/admin/index.ts'
import {
  CoreAlreadyRunning,
  type LocalListener,
  listenLocal,
  probeSocket,
  socketPathFor,
} from './modules/local-socket/index.ts'
import { createGuestListener, type GuestListener } from './modules/thalamus/index.ts'
import type { Config } from './platform/config.ts'
import { dbState, migrateWithBackup, refusalOf, secureDataDir } from './platform/db.ts'
import type { FileLogger } from './platform/logger.ts'
import { baseUrl, bindWarning, SERVER_LIMITS } from './platform/net.ts'

export class StartError extends Error {}

export interface RunOptions {
  config: Config
  logger: FileLogger
  /** Extra core options (tests: definitions, timing, catalogs). */
  core?: Partial<Omit<CoreOptions, 'config' | 'logger'>>
  /** Override the TCP port (tests use 0). */
  port?: number
  /** Override the guest listener's port (tests use 0); the setting `guests.port` otherwise. */
  guestPort?: number
}

export interface RunningCore {
  core: Core
  url: string
  socketPath: string
  /** The guest listener's port while guests are on and not killed, else undefined (the port is closed). */
  guestPort(): number | undefined
  /** Look at the guest settings now (the listener also does it every two seconds). */
  reconcileGuests(): void
  stop(): Promise<void>
}

/**
 * Run the core: migrate if the database is new or behind, hold `core.lock`, serve TCP and the
 * owner-only socket, and print where it listens. Shared by `keith-core start` and `main.ts`.
 */
export async function runCore(options: RunOptions): Promise<RunningCore> {
  const { config, logger } = options
  const socketPath = socketPathFor(config.dataDir)
  if (await probeSocket(socketPath)) throw new StartError(`core already running (${socketPath})`)
  // the folder is created private before the lock, so no migration runs without it (P26.1.3)
  for (const warning of secureDataDir(config.dataDir)) logger.warn(warning)
  let lock: FileLock
  try {
    lock = acquireLock(join(config.dataDir, LOCK_FILE))
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new StartError(`core already running or being set up (pid ${error.pid})`)
    }
    throw error
  }
  let core: Core | undefined
  let local: LocalListener | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    // a database another build wrote, or one that cannot be read, is refused before anything touches it
    const refusal = refusalOf(dbState(config.dbFile, options.core?.plugins), config)
    if (refusal !== undefined) throw new StartError(refusal)
    // a behind database is snapshotted, then migrated; the block is logged by migrateWithBackup
    const outcome = migrateWithBackup(config, options.core?.plugins, logger, 'local')
    if (outcome.kind === 'created') logger.info(`database ${config.dbFile} created`)
    core = await createCore({ config, logger, ...options.core })
    const net = core.network()
    // Authorized requests lift the idle timeout (see createCore.fetch), so chat streams stay
    // open; the short one bounds connections that never authenticate.
    server = Bun.serve({
      hostname: net.host,
      port: options.port ?? net.port,
      fetch: core.fetch,
      websocket: core.websocket,
      ...SERVER_LIMITS,
    })
    const port = server.port ?? net.port
    core.announce({ host: net.host, port })
    local = await listenLocal({
      dataDir: config.dataDir,
      fetch: core.fetchLocal,
      websocket: core.websocket as never,
      idleTimeout: SERVER_LIMITS.idleTimeout,
      maxRequestBodySize: SERVER_LIMITS.maxRequestBodySize,
    })
    const warning = bindWarning(net.host)
    if (warning !== undefined) logger.warn(warning)
    // the second listener serves /guest/* only and exists only while guests are on (docs/specs/guests.md)
    const guestListener: GuestListener = createGuestListener({
      http: core.guestHttp,
      log: logger,
      ...(options.guestPort === undefined ? {} : { port: options.guestPort }),
    })
    guestListener.reconcile()
    const url = baseUrl(net.host, port)
    logger.info(`keith core ${core.health.version} (${core.health.sha}) on ${url}`)
    logger.info(`local socket ${local.path} (owner access, mode 0600)`)
    const running = { core, local, server }
    return {
      core,
      url,
      socketPath: local.path,
      guestPort: () => guestListener.port(),
      reconcileGuests: () => guestListener.reconcile(),
      async stop() {
        // the lock goes even when a step throws: a stale lock would block the next start
        try {
          await guestListener.stop()
          await running.server.stop(true)
          await running.local.stop()
          await running.core.close()
        } finally {
          lock.release()
        }
      },
    }
  } catch (error) {
    await server?.stop(true)
    await local?.stop().catch(() => undefined)
    await core?.close().catch(() => undefined)
    lock.release()
    if (error instanceof CoreAlreadyRunning) throw new StartError(error.message)
    throw error
  }
}

/** A stop that has not finished after this long forces the exit (FD11-06). */
export const STOP_CAP_MS = 10_000
/** A flush at exit (or after a crash) gives up after this long. */
export const FLUSH_CAP_MS = 2_000

export interface SignalStopOptions {
  /** Exit function (tests). Default `process.exit`. */
  exit?: (code: number) => void
  /** Stop cap in ms (tests). Default `STOP_CAP_MS`. */
  capMs?: number
}

/**
 * The stop handler for SIGINT and SIGTERM. A failed stop is logged and exits 1 (the lock is
 * released by `running.stop`'s finally); a stop that hangs is forced out at the cap; a second
 * signal while stopping does not run stop again: it flushes the log and exits 1 at once.
 */
export function signalStop(
  running: RunningCore,
  logger: FileLogger,
  options: SignalStopOptions = {},
): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const capMs = options.capMs ?? STOP_CAP_MS
  let stopping = false
  const end = async (code: number): Promise<void> => {
    await logger.flush(FLUSH_CAP_MS)
    exit(code)
  }
  return async (signal: string) => {
    if (stopping) {
      logger.warn(`${signal} while stopping: exiting now`)
      await end(1)
      return
    }
    stopping = true
    logger.info(`keith core stopping (${signal})`)
    const forced = setTimeout(() => {
      logger.error(`stop did not finish within ${capMs} ms: exiting`)
      void end(1)
    }, capMs)
    try {
      await running.stop()
      clearTimeout(forced)
      logger.info('stopped')
      await end(0)
    } catch (error) {
      clearTimeout(forced)
      logger.error(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
      await end(1)
    }
  }
}

/** Run until SIGINT or SIGTERM, then stop cleanly and exit. */
export function exitOnSignals(running: RunningCore, logger: FileLogger): void {
  const stop = signalStop(running, logger)
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
}

/**
 * Log an uncaught exception or unhandled rejection and exit 1, so the line that explains the
 * crash is on disk (FD11-06). The flush gives up after `FLUSH_CAP_MS`. Once a crash is being
 * handled, a second one only exits.
 */
export function installCrashHandlers(logger: FileLogger): void {
  let crashing = false
  const crash = (label: string, reason: unknown): void => {
    const error = reason instanceof Error ? reason : undefined
    if (crashing) {
      process.exit(1)
      return
    }
    crashing = true
    logger.error(`${label}: ${error?.message ?? String(reason)}`, {
      ...(error?.stack === undefined ? {} : { stack: error.stack }),
    })
    void logger.flush(FLUSH_CAP_MS).finally(() => process.exit(1))
  }
  process.on('uncaughtException', (error) => crash('uncaught exception', error))
  process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason))
}
