// Wires the core together in the order of docs/architecture/core.md "Construction order", and
// takes it apart again on shutdown. The only file that constructs implementations from several
// folders (R-3).

import { mkdir } from 'node:fs/promises'
import type { AnyPluginDefinition } from '@keith/sdk'
import pkg from '../package.json' with { type: 'json' }
import { registerBuiltins } from './builtins/index.ts'
import { keithPaths, loadConfig } from './config/index.ts'
import type { ConfigFlags, KeithConfig, KeithPaths } from './config/types.ts'
import { createEventBus } from './events/index.ts'
import type { CoreEventBus } from './events/types.ts'
import { MemoryStore } from './memory/index.ts'
import type { MindThreadManager } from './mind/index.ts'
import { createContextBuilder, createRunLoop, createThreadManager, personaFromFile } from './mind/index.ts'
import {
  createAgentRegistry,
  createPluginDataStores,
  createPluginHost,
  createProviderRegistries,
  createServiceRegistry,
  createSkillRegistry,
  createToolRegistry,
  type PluginImporter,
} from './plugins/index.ts'
import type { PluginHost } from './plugins/types.ts'
import { createScheduling } from './scheduler/index.ts'
import {
  type ConnectionTiming,
  createAttachmentRegistry,
  createCoreServer,
  createPresence,
} from './server/index.ts'
import { createIds, createLogger, systemClock } from './shared/index.ts'
import type { Clock, Logger, ThreadId } from './shared/types.ts'
import { openDb } from './storage/index.ts'
import type { Repositories } from './storage/types.ts'

/** Keith's version, reported by `/v1/health`, `welcome` and `keith --version`. */
export const KEITH_VERSION: string = pkg.version

export type BootstrapOptions = {
  /** `KEITH_HOME`. Must hold `config.toml` (written by `keith setup`). */
  home: string
  /** CLI flags (highest config precedence). Tests pass `{ port: 0 }`. */
  flags?: ConfigFlags | undefined
  /** Environment for `KEITH__` overrides and `env:` references. Default `process.env`. */
  env?: Record<string, string | undefined> | undefined
  /** Test only: plugin objects loaded after the configured ones (e.g. the fake LLM plugin). */
  plugins?: AnyPluginDefinition[] | undefined
  /** Test only: a fake clock. */
  clock?: Clock | undefined
  /** Default: JSON lines on stdout. */
  log?: Logger | undefined
  /** Test only: how plugin packages are imported. Default: dynamic `import()`. */
  importModule?: PluginImporter | undefined
  /** Test only: shorter handshake and heartbeat timers. */
  timing?: Partial<ConnectionTiming> | undefined
}

/** A running Keith. */
export interface Keith {
  readonly config: KeithConfig
  readonly paths: KeithPaths
  readonly version: string
  /** Where the server listens (the real port when `server.port` is 0). */
  readonly host: string
  readonly port: number
  /** `http://<host>:<port>`. */
  readonly url: string
  readonly log: Logger
  readonly events: CoreEventBus
  readonly repos: Repositories
  readonly threads: MindThreadManager
  readonly plugins: PluginHost
  /**
   * Graceful shutdown: stop accepting connections, cancel running turns (their partial text is
   * persisted with `meta.cancelled`), flush presence, stop tasks and plugins, close the database.
   * Idempotent; later calls return the same promise.
   */
  stop(): Promise<void>
}

type Closer = { name: string; run: () => Promise<void> | void }

/** Builds and starts Keith. On any failure, whatever was already built is torn down again. */
export async function bootstrap(opts: BootstrapOptions): Promise<Keith> {
  const closers: Closer[] = []
  const unwind = async (log: Logger | null) => {
    for (const closer of closers.splice(0).reverse()) {
      try {
        await closer.run()
      } catch (error) {
        log?.error('shutdown step failed', { step: closer.name, error: String(error) })
      }
    }
  }

  // 1. config → logger, clock, ids
  const clock = opts.clock ?? systemClock
  const config = await loadConfig({ home: opts.home, flags: opts.flags, env: opts.env })
  const paths = keithPaths(opts.home)
  const log = opts.log ?? createLogger({ clock })
  const ids = createIds({ clock })
  try {
    for (const dir of [paths.home, paths.filesDir, paths.pluginsDir, paths.logsDir]) {
      await mkdir(dir, { recursive: true })
    }

    // 2. db + repositories → event bus
    const db = openDb(paths.dbFile)
    closers.push({ name: 'db', run: () => db.close() })
    const { repos } = db
    const events = createEventBus({ log, clock })
    closers.push({ name: 'events', run: () => events.idle() })

    // 3. registries
    const services = createServiceRegistry({ winners: config.services, log })
    const tools = createToolRegistry({ log, clock, services, events })
    const skills = createSkillRegistry()
    const agents = createAgentRegistry({ tools })
    const providers = createProviderRegistries({ models: config.models })
    const data = createPluginDataStores({ repo: repos.pluginData, clock })

    // 4. attachments + presence
    const attachments = createAttachmentRegistry({ log })
    const presence = createPresence({ config, clock, log, events, persons: repos.persons })
    closers.push({ name: 'presence', run: () => presence.dispose() })

    // 5. run loop
    const runLoop = createRunLoop({
      providers,
      tools,
      repos,
      events,
      ids,
      clock,
      log,
      stallMs: config.mind.turn.stallMs,
    })

    // 6. scheduler, tasks, commitments, deliveries
    const scheduling = createScheduling({ config, repos, runLoop, agents, events, ids, clock, log })
    closers.push({ name: 'scheduling', run: () => scheduling.stop() })

    // 7. memory
    const memory = new MemoryStore({ repos, events, config, clock, ids, log })
    closers.push({ name: 'memory', run: () => memory.stop() })

    // 8. ThreadManager
    const context = createContextBuilder({
      config,
      persona: personaFromFile(paths.personaFile),
      clock,
      repos,
      memory,
      commitments: scheduling.commitments,
      skills,
      tools,
    })
    const threads = createThreadManager({
      config,
      repos,
      nodes: attachments,
      presence,
      scheduler: scheduling.scheduler,
      deliveries: scheduling.deliveries,
      context,
      runLoop,
      events,
      ids,
      clock,
      log,
      // ui.action: clicks reach the originating tool's onAction, which may use services.
      tools,
      services,
    })
    const turns = trackRunningTurns(events)
    closers.push({ name: 'threads', run: () => threads.stop() })

    // 9. server (not listening yet)
    const server = createCoreServer({
      config,
      log,
      clock,
      ids,
      events,
      repos,
      threads,
      attachments,
      presence,
      version: KEITH_VERSION,
      filesDir: paths.filesDir,
      timing: opts.timing,
    })

    // 10. built-in tools
    registerBuiltins({ tools, tasks: scheduling.tasks, memory, persons: repos.persons, skills })

    // 11. plugin host → load → setup → start
    const plugins = createPluginHost(
      {
        paths,
        log,
        clock,
        events,
        services,
        tools,
        skills,
        agents,
        providers,
        http: server.http,
        ws: server.ws,
        deliveries: scheduling.deliverySinks,
        data,
      },
      { importModule: opts.importModule },
    )
    closers.push({ name: 'plugins', run: () => plugins.stopAll() })
    await plugins.load(config, opts.plugins ?? [])
    await plugins.startAll()

    // 12. scheduler start, server listen → core.started
    await scheduling.start()
    const bound = await server.listen()
    closers.push({ name: 'server', run: () => server.stop() })
    const url = `http://${bound.host.includes(':') ? `[${bound.host}]` : bound.host}:${bound.port}`
    events.emit('core.started', { version: KEITH_VERSION })
    log.info('keith started', { version: KEITH_VERSION, url })

    let stopping: Promise<void> | null = null
    const shutdown = async () => {
      log.info('keith stopping')
      events.emit('core.stop_requested', {})
      closers.length = 0
      const step = async (name: string, run: () => Promise<void> | void) => {
        try {
          await run()
        } catch (error) {
          log.error('shutdown step failed', { step: name, error: String(error) })
        }
      }
      // Presence first (C1): the last-seen time of everyone still here, before sockets close.
      await step('presence.flush', () => presence.flushPresence())
      // Stop accepting connections and input; close open sockets.
      await step('server', () => server.stop())
      // No new delivery turns or arrival holds, then cancel whatever turn still runs.
      await step('threads.stop', () => threads.stop())
      await step('turns', () => cancelRunningTurns(threads, turns, events, ids))
      turns.dispose()
      await step('presence.dispose', () => presence.dispose())
      // Aborts running tasks without changing their stored status (recovered on the next start).
      await step('scheduling', () => scheduling.stop())
      await step('memory', () => memory.stop())
      await step('plugins', () => plugins.stopAll())
      await step('events', () => events.idle())
      await step('db', () => db.close())
      log.info('keith stopped')
    }

    return {
      config,
      paths,
      version: KEITH_VERSION,
      host: bound.host,
      port: bound.port,
      url,
      log,
      events,
      repos,
      threads,
      plugins,
      stop() {
        stopping ??= shutdown()
        return stopping
      },
    }
  } catch (error) {
    const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined
    log.error('keith failed to start', { error: String(error), ...(cause ? { cause } : {}) })
    await unwind(log)
    throw error
  }
}

type RunningTurns = { threads(): ThreadId[]; dispose(): void }

/** Threads whose turn state is not idle, from `thread.state_changed`. */
function trackRunningTurns(events: CoreEventBus): RunningTurns {
  const busy = new Set<ThreadId>()
  const off = events.on('thread.state_changed', (e) => {
    if (e.data.to === 'idle') busy.delete(e.data.threadId)
    else busy.add(e.data.threadId)
  })
  return { threads: () => [...busy], dispose: off }
}

/** Aborts every running turn and waits until each one has persisted its partial reply. */
async function cancelRunningTurns(
  threads: MindThreadManager,
  turns: RunningTurns,
  events: CoreEventBus,
  ids: { next(prefix: 'nod'): `nod_${string}` },
): Promise<void> {
  // `cancel` needs a node id for the frame it answers; shutdown has none, so it uses its own.
  const nodeId = ids.next('nod')
  for (let round = 0; round < 10; round++) {
    await events.idle()
    const running = turns.threads()
    if (running.length === 0) return
    for (const threadId of running) threads.cancel({ threadId, nodeId })
    await threads.idle()
  }
}
