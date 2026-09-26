import type { z } from 'zod'
import type { Agent } from '../agents.ts'
import type { Clock, LogFields, Logger } from '../common.ts'
import { KeithError } from '../errors.ts'
import type { EventBus, EventHandler, EventMap, EventName, KeithEvent } from '../events.ts'
import {
  type AnyPluginDefinition,
  type DeliverySink,
  type HttpHandler,
  type HttpMethod,
  type HttpRegistry,
  KIND_REGISTRIES,
  type KindScopedRegistry,
  type PluginContext,
  type PluginDataStore,
  type PluginDelivery,
  type PluginInfo,
  type PluginKind,
  type ProviderRegistries,
  type ServiceMap,
  type ServiceRegistry,
  type WsRegistry,
} from '../plugin.ts'
import type { LlmProvider, SttProvider, TtsProvider, VadProvider } from '../providers/types.ts'
import type { Skill, SkillRegistry } from '../skills.ts'
import { assertToolName, type Tool, type ToolRegistry } from '../tools.ts'

// Clock and logger

export type FakeClock = Clock & {
  set(ms: number): void
  advance(ms: number): void
}

/** A clock that moves only when told to. Pair it with `jest.useFakeTimers()` for timers. */
export function createFakeClock(start = 0): FakeClock {
  let now = start
  return {
    now: () => now,
    set(ms) {
      now = ms
    },
    advance(ms) {
      now += ms
    },
  }
}

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; fields: LogFields }

export type MemoryLogger = Logger & { readonly entries: LogEntry[] }

/** A logger that keeps every line in memory, for assertions. Child loggers share the entries. */
export function createMemoryLogger(base: LogFields = {}, entries: LogEntry[] = []): MemoryLogger {
  const write =
    (level: LogEntry['level']) =>
    (msg: string, fields: LogFields = {}) => {
      entries.push({ level, msg, fields: { ...base, ...fields } })
    }
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (fields) => createMemoryLogger({ ...base, ...fields }, entries),
  }
}

// Fake plugin context

export type RecordedRoute = {
  method: HttpMethod
  path: string
  handler: HttpHandler
  auth: 'none' | 'bearer'
}

/** Everything a plugin registered or emitted through the fake context. */
export type FakeRecord = {
  tools: Tool[]
  skills: Skill[]
  agents: Agent[]
  llm: LlmProvider[]
  stt: SttProvider[]
  tts: TtsProvider[]
  vad: VadProvider[]
  routes: RecordedRoute[]
  statics: { mountPath: string; dir: string; spaFallback: string | undefined }[]
  wsHandlers: { type: string; schema: z.ZodType; handler: (data: unknown, c: never) => unknown }[]
  deliveries: PluginDelivery[]
  events: { name: string; data: unknown }[]
  eventSchemas: Map<string, z.ZodType>
  services: Map<string, unknown>
}

export type FakePluginContext<TConfig> = PluginContext<TConfig> & {
  readonly recorded: FakeRecord
  readonly log: MemoryLogger
  readonly clock: FakeClock
  /** Delivers an event to this plugin's handlers as if another emitter published it (e.g. a core event). */
  fire<N extends EventName>(name: N, data: EventMap[N]): Promise<void>
  /** Resolves when every pending event handler has run. */
  settle(): Promise<void>
}

export type FakePluginContextOptions<TConfig> = {
  kind: PluginKind
  config: TConfig
  plugin?: Partial<Omit<PluginInfo, 'kind'>>
  /** Services other plugins "provide", available to `services.get`. */
  services?: Record<string, unknown>
  clock?: FakeClock
  dataDir?: string
}

/**
 * An in-memory `PluginContext` for plugin unit tests. It enforces the kind table
 * (`PLUGIN_KIND_VIOLATION`), the service rules (`SERVICE_CONFLICT`, `SERVICE_MISSING`), tool name
 * rules and the emit namespace, and records every registration in `recorded`.
 */
export function createFakePluginContext<TConfig>(
  opts: FakePluginContextOptions<TConfig>,
): FakePluginContext<TConfig> {
  const namespace = opts.plugin?.namespace ?? 'fake'
  const info: PluginInfo = {
    id: opts.plugin?.id ?? `@keith/${namespace}`,
    namespace,
    version: opts.plugin?.version ?? '0.0.0',
    kind: opts.kind,
  }
  const recorded: FakeRecord = {
    tools: [],
    skills: [],
    agents: [],
    llm: [],
    stt: [],
    tts: [],
    vad: [],
    routes: [],
    statics: [],
    wsHandlers: [],
    deliveries: [],
    events: [],
    eventSchemas: new Map(),
    services: new Map(Object.entries(opts.services ?? {})),
  }
  const log = createMemoryLogger({ pluginId: info.id })
  const clock = opts.clock ?? createFakeClock()
  const allowed = new Set<KindScopedRegistry>(KIND_REGISTRIES[opts.kind])

  const guard = (registry: KindScopedRegistry) => {
    if (!allowed.has(registry)) {
      throw new KeithError(
        'PLUGIN_KIND_VIOLATION',
        `plugin ${info.id} of kind '${info.kind}' may not use ctx.${registry}`,
      )
    }
  }

  const tools: ToolRegistry = {
    register(tool) {
      guard('tools')
      assertToolName(tool.name)
      if (!tool.name.startsWith(`${namespace}.`)) {
        throw new KeithError('TOOL_NAME_INVALID', `tool '${tool.name}' must start with '${namespace}.'`)
      }
      if (recorded.tools.some((t) => t.name === tool.name)) {
        throw new KeithError('TOOL_NAME_TAKEN', `tool '${tool.name}' is already registered`)
      }
      recorded.tools.push(tool)
    },
  }
  const skills: SkillRegistry = {
    register(skill) {
      guard('skills')
      recorded.skills.push(skill)
    },
  }
  const agents = {
    register(agent: Agent) {
      guard('agents')
      recorded.agents.push(agent)
    },
  }
  const providers: ProviderRegistries = {
    llm: {
      register(p) {
        guard('providers')
        recorded.llm.push(p)
      },
    },
    stt: {
      register(p) {
        guard('providers')
        recorded.stt.push(p)
      },
    },
    tts: {
      register(p) {
        guard('providers')
        recorded.tts.push(p)
      },
    },
    vad: {
      register(p) {
        guard('providers')
        recorded.vad.push(p)
      },
    },
  }
  const http: HttpRegistry = {
    route(method, path, handler, routeOpts) {
      guard('http')
      recorded.routes.push({ method, path, handler, auth: routeOpts?.auth ?? 'bearer' })
    },
    static(mountPath, dir, staticOpts) {
      guard('http')
      recorded.statics.push({ mountPath, dir, spaFallback: staticOpts?.spaFallback })
    },
  }
  const ws: WsRegistry = {
    handle(type, schema, handler) {
      guard('ws')
      if (!type.startsWith(`${namespace}.`)) {
        throw new KeithError(
          'PLUGIN_NAMESPACE_INVALID',
          `ws frame type '${type}' must start with '${namespace}.'`,
        )
      }
      recorded.wsHandlers.push({ type, schema, handler })
    },
  }
  let deliverySeq = 0
  const deliveries: DeliverySink = {
    // Not async: a kind violation throws at the call, like every other registry.
    enqueue(d) {
      guard('deliveries')
      recorded.deliveries.push(d)
      deliverySeq += 1
      return Promise.resolve({ deliveryId: `dlv_${String(deliverySeq).padStart(26, '0')}` })
    },
  }

  const services: ServiceRegistry = {
    provide(name, impl) {
      if (recorded.services.has(name)) {
        throw new KeithError('SERVICE_CONFLICT', `service '${name}' is already provided`)
      }
      recorded.services.set(name, impl)
    },
    get(name) {
      if (!recorded.services.has(name))
        throw new KeithError('SERVICE_MISSING', `service '${name}' is missing`)
      return recorded.services.get(name) as ServiceMap[typeof name]
    },
    find(name) {
      return recorded.services.get(name) as ServiceMap[typeof name] | undefined
    },
  }

  const handlers = new Map<string, Set<(e: KeithEvent<EventName>) => void | Promise<void>>>()
  let pending: Promise<unknown>[] = []
  const dispatch = (name: string, data: unknown) => {
    const event = { name, at: clock.now(), data } as KeithEvent<EventName>
    for (const handler of handlers.get(name) ?? []) {
      pending.push(
        Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) =>
            log.error('event handler failed', { event: name, error: String(error) }),
          ),
      )
    }
  }
  const events: EventBus = {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      const h = handler as EventHandler<EventName>
      set.add(h)
      handlers.set(name, set)
      return () => set.delete(h)
    },
    emit(name, data) {
      if (!name.startsWith(`${namespace}.`)) {
        throw new KeithError('PLUGIN_NAMESPACE_INVALID', `plugin ${info.id} may not emit '${name}'`)
      }
      recorded.events.push({ name, data })
      dispatch(name, data)
    },
    define(name, schema) {
      recorded.eventSchemas.set(name, schema)
    },
  }

  const store = new Map<string, string>()
  const data: PluginDataStore = {
    async get<T>(key: string) {
      const raw = store.get(key)
      return raw === undefined ? undefined : (JSON.parse(raw) as T)
    },
    async set(key, value) {
      store.set(key, JSON.stringify(value))
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix = '') {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
  }

  const settle = async () => {
    while (pending.length > 0) {
      const batch = pending
      pending = []
      await Promise.all(batch)
    }
  }

  return {
    plugin: info,
    config: opts.config,
    log,
    events,
    services,
    tools,
    skills,
    agents,
    providers,
    http,
    ws,
    deliveries,
    data,
    paths: { data: opts.dataDir ?? `/tmp/keith-fake-plugins/${info.id}` },
    clock,
    recorded,
    async fire(name, eventData) {
      dispatch(name, eventData)
      await settle()
    },
    settle,
  }
}

export type SetupFakePluginOptions = Omit<FakePluginContextOptions<unknown>, 'kind' | 'config' | 'plugin'> & {
  /** Raw config, parsed with the plugin's own schema like the host does. */
  config?: unknown
  /** Also run `start`. Default false. */
  start?: boolean
}

/**
 * Loads a plugin the way the host would, against a fake context: parses its config, runs `setup`
 * (and `start` when asked) and returns the context with everything it registered.
 */
export async function setupFakePlugin(
  plugin: AnyPluginDefinition,
  options: SetupFakePluginOptions = {},
): Promise<FakePluginContext<unknown>> {
  let config: unknown = {}
  if (plugin.config) {
    const parsed = plugin.config.safeParse(options.config ?? {})
    if (!parsed.success) {
      throw new KeithError('CONFIG_INVALID', `config for ${plugin.id} is invalid`, { cause: parsed.error })
    }
    config = parsed.data
  }
  const { config: _raw, start, ...rest } = options
  const ctx = createFakePluginContext({
    ...rest,
    kind: plugin.kind,
    config,
    plugin: { id: plugin.id, namespace: plugin.namespace, version: plugin.version },
  })
  await plugin.setup(ctx)
  if (start) await plugin.start?.(ctx)
  return ctx
}
