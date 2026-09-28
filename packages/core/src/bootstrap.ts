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
import { createReflection, createThreadSummaries, MemoryStore } from './memory/index.ts'
import type { MindThreadManager } from './mind/index.ts'
import {
  createAddressing,
  createContextBuilder,
  createGroupThreads,
  createRunLoop,
  createThreadManager,
  personaFromFile,
} from './mind/index.ts'
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
import {
  acquireHomeLock,
  createIds,
  createLogFile,
  createLogger,
  type LogFile,
  systemClock,
} from './shared/index.ts'
import type { Clock, Logger, NodeId } from './shared/types.ts'
import { openDb } from './storage/index.ts'
import type { Repositories } from './storage/types.ts'
import { checkVoiceProviders, createVoice } from './voice/index.ts'

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
  /**
   * Default: JSON lines on stdout and in `logs/keith.log` (rotated, config.md#logs-and-lock). A
   * logger passed here gets no log file.
   */
  log?: Logger | undefined
  /** Test only: where the default logger writes instead of stdout (the log file still gets every line). */
  logWrite?: ((line: string) => void) | undefined
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
   * persisted with `meta.cancelled`), flush presence, stop tasks and plugins, close the database
   * and the log file, and release the home lock last. Idempotent; later calls return the same promise.
   */
  stop(): Promise<void>
}

type Closer = { name: string; run: () => Promise<void> | void }

/**
 * Builds and starts Keith. On any failure, whatever was already built is torn down again. Fails
 * (`INTERNAL`, naming the pid) when another Keith holds the home's lock (I-1).
 */
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

  // 0. the home lock (I-1: exactly one Mind per home). Taken first, released last.
  const clock = opts.clock ?? systemClock
  const paths = keithPaths(opts.home)
  const lock = await acquireHomeLock(paths.home, { clock })
  closers.push({ name: 'lock', run: () => lock.release() })

  // Null until the logger exists (a failure before that has nothing to log to).
  let startLog: Logger | null = opts.log ?? null
  try {
    // 1. config → logger (stdout + logs/keith.log), clock, ids
    const config = await loadConfig({ home: opts.home, flags: opts.flags, env: opts.env })
    for (const dir of [paths.home, paths.filesDir, paths.pluginsDir, paths.logsDir]) {
      await mkdir(dir, { recursive: true })
    }
    let logFile: LogFile | null = null
    if (!startLog) {
      const file = createLogFile({ dir: paths.logsDir })
      logFile = file
      closers.push({ name: 'log file', run: () => file.close() })
      startLog = createLogger({ clock, write: opts.logWrite, file })
    }
    const log: Logger = startLog
    const ids = createIds({ clock })

    // 2. db + repositories → event bus
    const db = openDb(paths.dbFile)
    closers.push({ name: 'db', run: () => db.close() })
    const { repos } = db
    const events = createEventBus({ log, clock })
    closers.push({ name: 'events', run: () => events.idle() })

    // 3. registries
    const services = createServiceRegistry({ winners: config.services, log })
    const tools = createToolRegistry({ log, clock, services, events })
    const skills = createSkillRegistry({ log: log.child({ component: 'skills' }) })
    const agents = createAgentRegistry({ tools })
    const providers = createProviderRegistries({ models: config.models })
    const data = createPluginDataStores({ repo: repos.pluginData, clock })

    // 4. attachments + presence
    const attachments = createAttachmentRegistry({ log })
    const presence = createPresence({ config, clock, log, events, persons: repos.persons })
    closers.push({ name: 'presence', run: () => presence.dispose() })

    // 4b. voice pipeline (phase 3), only with a `[voice]` section. It needs the ThreadManager and
    // the ThreadManager needs its output, so the ThreadManager is reached through a late binding.
    // Providers are looked up by id per stream; the ids are checked once the plugins started (11).
    let threadsRef: MindThreadManager | null = null
    const lateThreads = (): MindThreadManager => {
      if (!threadsRef) throw new Error('voice used before the ThreadManager was built')
      return threadsRef
    }
    const nodeCapabilities = trackNodeCapabilities(events)
    closers.push({ name: 'voice.capabilities', run: () => nodeCapabilities.dispose() })
    const voice = config.voice
      ? createVoice({
          providers,
          config: config.voice,
          threads: {
            input: (a) => lateThreads().input(a),
            voiceActivity: (a) => lateThreads().voiceActivity(a),
          },
          nodes: attachments,
          capabilities: (nodeId) => nodeCapabilities.of(nodeId),
          ids,
          clock,
          log,
        })
      : undefined

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
    // Phase 4 memory jobs (ADR-0014): reflection on idle threads (per `scheduler.ticked`) and
    // thread summaries (per `turn.completed`). Both run utility-model calls in the background lane.
    // Started in step 12; stopped (running passes aborted) before scheduling stops.
    const reflection = createReflection({
      config,
      repos,
      memory,
      runLoop,
      scheduler: scheduling.scheduler,
      events,
      clock,
      ids,
      log: log.child({ component: 'reflection' }),
    })
    const summaries = createThreadSummaries({
      config,
      repos,
      runLoop,
      scheduler: scheduling.scheduler,
      events,
      clock,
      ids,
      log: log.child({ component: 'summaries' }),
    })

    // 8. ThreadManager, with the group-thread services (phase 5): the addressing detector decides
    // whether a group input is for the Mind (its classifier runs in the foreground lane), and
    // `GroupThreads` changes membership for the thread tools (step 10).
    const addressing = createAddressing({
      config,
      runLoop,
      scheduler: scheduling.scheduler,
      log: log.child({ component: 'addressing' }),
    })
    const groups = createGroupThreads({
      config,
      repos,
      deliveries: scheduling.deliveries,
      events,
      ids,
      clock,
      log: log.child({ component: 'groups' }),
    })
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
      // Phase 3: spoken replies on the focus node; `config.voice` also sets barge-in.
      voice: voice?.output,
      addressing,
    })
    threadsRef = threads
    closers.push({ name: 'threads', run: () => threads.stop() })

    // 9. server (not listening yet)
    let pluginsRef: PluginHost | null = null
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
      voice: voice?.input,
      // Notices after `welcome` (protocol.md#notices). The host is built in step 11.
      pluginStatus: () => pluginsRef?.status() ?? [],
      voiceConfigured: config.voice !== undefined,
    })

    // 10. built-in tools
    registerBuiltins({
      tools,
      tasks: scheduling.tasks,
      memory,
      persons: repos.persons,
      skills,
      reminders: { service: scheduling.reminders, config, clock },
      relay: { service: scheduling.relay, persons: repos.persons },
      groups: { service: groups, persons: repos.persons, threads: repos.threads, config },
    })

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
    pluginsRef = plugins
    closers.push({ name: 'plugins', run: () => plugins.stopAll() })
    await plugins.load(config, opts.plugins ?? [])
    await plugins.startAll()
    // Every `[voice]` id must name a registered provider (CONFIG_INVALID otherwise).
    checkVoiceProviders(config.voice, providers)

    // 12. scheduler start, server listen → core.started
    await scheduling.start()
    // Closers run in reverse, so on a failed start the jobs stop before scheduling does.
    reflection.job.start()
    closers.push({ name: 'reflection', run: () => reflection.job.stop() })
    summaries.job.start()
    closers.push({ name: 'summaries', run: () => summaries.job.stop() })
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
      // No new turns or arrival holds, then cancel whatever turn still runs (each persists its
      // partial reply with `meta.cancelled` before cancelAll resolves).
      await step('threads.stop', () => threads.stop())
      await step('threads.cancelAll', () => threads.cancelAll())
      await step('presence.dispose', () => presence.dispose())
      // Memory jobs: unsubscribe and abort running passes (an aborted pass writes nothing), before
      // scheduling stops its lanes.
      await step('reflection', () => reflection.job.stop())
      await step('summaries', () => summaries.job.stop())
      // Aborts running tasks without changing their stored status (recovered on the next start).
      await step('scheduling', () => scheduling.stop())
      await step('memory', () => memory.stop())
      await step('plugins', () => plugins.stopAll())
      await step('events', () => events.idle())
      await step('db', () => db.close())
      log.info('keith stopped')
      await step('log file', () => logFile?.close())
      // Last: another Keith may start on this home from here on.
      await step('lock', () => lock.release())
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
    startLog?.error('keith failed to start', { error: String(error), ...(cause ? { cause } : {}) })
    await unwind(startLog)
    throw error
  }
}

type NodeCapabilities = { of(nodeId: NodeId): readonly string[]; dispose(): void }

/**
 * The capabilities each node declared in its latest `hello` (`node.connected`), for the voice
 * pipeline's `audio.out@1` check. Kept after a disconnect: a node id's next hello replaces them,
 * and speech to a gone node goes nowhere anyway.
 */
function trackNodeCapabilities(events: CoreEventBus): NodeCapabilities {
  const byNode = new Map<NodeId, readonly string[]>()
  const off = events.on('node.connected', (e) => {
    byNode.set(e.data.nodeId, e.data.capabilities)
  })
  return { of: (nodeId) => byNode.get(nodeId) ?? [], dispose: off }
}
