import type { PersonDto, UiBlock } from '@keith/protocol'
import type { z } from 'zod'
import type { AgentRegistry } from './agents.ts'
import type { Clock, Logger, Urgency } from './common.ts'
import type { EventBus } from './events.ts'
import type { LlmProvider, SttProvider, TtsProvider, VadProvider } from './providers/types.ts'
import type { SkillRegistry } from './skills.ts'
import type { ToolRegistry } from './tools.ts'

export type PluginKind = 'infra' | 'provider' | 'tool' | 'client-app'
export const PLUGIN_KINDS: readonly PluginKind[] = ['infra', 'provider', 'tool', 'client-app']

/** Registries whose use depends on the plugin kind. Services, events, data, paths and clock are for every kind. */
export type KindScopedRegistry = 'tools' | 'skills' | 'agents' | 'providers' | 'http' | 'ws' | 'deliveries'

/** Which kind may use which registry (docs/architecture/plugin-system.md#plugin-kinds). */
export const KIND_REGISTRIES: Readonly<Record<PluginKind, readonly KindScopedRegistry[]>> = {
  infra: ['http', 'ws'],
  provider: ['providers'],
  tool: ['tools', 'skills', 'agents', 'deliveries'],
  'client-app': ['http', 'ws', 'deliveries'],
}

/** `namespace` format: lowercase, single underscores. */
export const PLUGIN_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

/** Namespaces reserved for the core and built-ins. */
export const RESERVED_NAMESPACES = [
  'core',
  'plugin',
  'node',
  'person',
  'thread',
  'turn',
  'tool',
  'task',
  'commitment',
  'delivery',
  'memory',
  'scheduler',
  'skill',
  'reminder',
  'relay',
  'workspace',
  'p',
  'v1',
] as const

// Services

/**
 * Named, typed in-process capabilities. Extended by declaration merging in the providing
 * plugin's type-only `/service` entry:
 *
 * ```ts
 * declare module '@keith/sdk' {
 *   interface ServiceMap { weather: { forecast(city: string): Promise<Forecast> } }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point, filled by declaration merging
export interface ServiceMap {}

export type ServiceName = keyof ServiceMap & string

export interface ServiceRegistry {
  /** Setup only. Throws `SERVICE_CONFLICT` if the name is taken (unless config picks a winner). */
  provide<K extends ServiceName>(name: K, impl: ServiceMap[K]): void
  /** Start or later. Throws `SERVICE_MISSING`. */
  get<K extends ServiceName>(name: K): ServiceMap[K]
  find<K extends ServiceName>(name: K): ServiceMap[K] | undefined
}

// Providers

export interface ProviderRegistries {
  llm: { register(p: LlmProvider): void }
  /** Phase 3. */
  stt: { register(p: SttProvider): void }
  /** Phase 3. */
  tts: { register(p: TtsProvider): void }
  /** Phase 3. */
  vad: { register(p: VadProvider): void }
}

// HTTP and WS (infra, client-app)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpHandlerContext = { person: PersonDto | null; params: Record<string, string> }
export type HttpHandler = (req: Request, c: HttpHandlerContext) => Response | Promise<Response>

export interface HttpRegistry {
  /** Mounted under `/p/<namespace>/…`. `/v1/*` is reserved for the core (`ROUTE_CONFLICT`). */
  route(method: HttpMethod, path: string, handler: HttpHandler, opts?: { auth?: 'none' | 'bearer' }): void
  /** `mountPath: '/'` only for `client-app` plugins, and only one plugin may own `/`. */
  static(mountPath: string, dir: string, opts?: { spaFallback?: string }): void
}

export type WsHandlerContext = { nodeId: string; person: PersonDto | null }

export interface WsRegistry {
  /** Extra frame types, which must start with `<namespace>.`, e.g. `telegram.linked`. */
  handle(
    type: string,
    schema: z.ZodType,
    handler: (data: unknown, c: WsHandlerContext) => void | Promise<void>,
  ): void
}

// Deliveries (tool, client-app)

export type PluginDelivery = {
  personId: string
  text: string
  urgency?: Urgency | undefined
  ui?: UiBlock | undefined
  /** Default: the person's `main` thread. */
  threadId?: string | undefined
}

export interface DeliverySink {
  /** The source is recorded as the plugin id. */
  enqueue(d: PluginDelivery): Promise<{ deliveryId: string }>
}

// Plugin data (every kind)

export interface PluginDataStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  /** `value` must be JSON-serializable. */
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}

// Context and definition

export type PluginInfo = { id: string; namespace: string; version: string; kind: PluginKind }

export interface PluginContext<TConfig = unknown> {
  plugin: PluginInfo
  config: TConfig
  /** Child logger tagged with the plugin id. */
  log: Logger
  events: EventBus
  services: ServiceRegistry
  /** kind: tool */
  tools: ToolRegistry
  /** kind: tool */
  skills: SkillRegistry
  /** kind: tool */
  agents: AgentRegistry
  /** kind: provider */
  providers: ProviderRegistries
  /** kind: infra, client-app */
  http: HttpRegistry
  /** kind: infra, client-app */
  ws: WsRegistry
  /** kind: tool, client-app */
  deliveries: DeliverySink
  /** Every kind. */
  data: PluginDataStore
  /** `data` is `~/.keith/plugins/<id>/`. */
  paths: { data: string }
  clock: Clock
}

type EmptyConfig = z.ZodObject<Record<string, never>>

export interface PluginDefinition<TSchema extends z.ZodType = EmptyConfig> {
  /** The npm package name. */
  id: string
  /** Scopes tools, events, routes and ws frames. See `PLUGIN_NAMESPACE_PATTERN`. */
  namespace: string
  version: string
  kind: PluginKind
  /** Validated by the host before `setup`. Omit for a plugin without config. */
  config?: TSchema | undefined
  /** Service names that must exist at start. */
  needs?: string[] | undefined
  /** Register only. Don't call other plugins' services here. */
  setup(ctx: PluginContext<z.output<TSchema>>): void | Promise<void>
  /** All plugins are set up; services may be used. */
  start?(ctx: PluginContext<z.output<TSchema>>): void | Promise<void>
  /** Reverse load order, within `plugins.stopTimeoutMs`. */
  stop?(ctx: PluginContext<z.output<TSchema>>): void | Promise<void>
}

/**
 * A plugin whose config type is erased, as the host stores it. Any `PluginDefinition<S>` is
 * assignable to it (lifecycle hooks use method syntax, which TypeScript checks bivariantly).
 */
export type AnyPluginDefinition = PluginDefinition<z.ZodType>

/** Identity function that infers `ctx.config` from the `config` schema. */
export function definePlugin<TSchema extends z.ZodType = EmptyConfig>(
  plugin: PluginDefinition<TSchema>,
): PluginDefinition<TSchema> {
  return plugin
}
