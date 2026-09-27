// The plugin host and the core-internal registry APIs. Contracts: docs/contracts/plugin-api.md,
// docs/architecture/plugin-system.md. Implemented by plugins/ (task P1-A1).

import type {
  Agent,
  AgentRegistry,
  AnyPluginDefinition,
  DeliverySink,
  HttpRegistry,
  LlmProvider,
  PluginDataStore,
  PluginKind,
  ProviderRegistries,
  ServiceRegistry,
  Skill,
  SkillRegistry,
  SttProvider,
  Tool,
  ToolRegistry,
  ToolResult,
  TtsProvider,
  VadProvider,
  WsRegistry,
} from '@keith/sdk'
import type { KeithConfig, KeithPaths, ModelRef } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { Clock, Logger, ModelRole, PersonDto, TaskId, ThreadId, Tier } from '../shared/types.ts'

/** Who registered something. Used for namespace checks and for rolling back a failed plugin. */
export type PluginOwner = { pluginId: string; namespace: string; kind: PluginKind }

/**
 * A registry that hands each plugin its own view. The view checks the plugin's namespace and
 * records ownership; `removeByPlugin` rolls back everything a failed plugin registered.
 */
export interface PluginScoped<TView> {
  forPlugin(owner: PluginOwner): TView
  removeByPlugin(pluginId: string): void
}

// Plugin host

export type PluginState = 'set_up' | 'started' | 'failed' | 'stopped'

export type PluginStatus = {
  id: string
  namespace: string
  version: string
  kind: PluginKind
  state: PluginState
  /** Set when `state` is 'failed'. */
  error?: { stage: 'load' | 'setup' | 'start'; message: string } | undefined
}

export interface PluginHost {
  /**
   * Imports `config.plugins.enabled` in order (plus `extra`, used by tests and `bootstrap(opts)`),
   * validates each plugin's config section, checks namespaces, and runs `setup`. A failing plugin
   * is rolled back and marked failed; a failing `plugins.required` plugin makes this throw.
   */
  load(config: KeithConfig, extra?: AnyPluginDefinition[]): Promise<void>
  /** Checks `needs`, then runs `start` in load order. */
  startAll(): Promise<void>
  /** Runs `stop` in reverse load order, each within `plugins.stopTimeoutMs`. */
  stopAll(): Promise<void>
  status(): PluginStatus[]
}

/** What the host is constructed with (bootstrap step 11). */
export type PluginHostDeps = {
  paths: KeithPaths
  log: Logger
  clock: Clock
  events: CoreEventBus
  services: CoreServiceRegistry
  tools: CoreToolRegistry
  skills: CoreSkillRegistry
  agents: CoreAgentRegistry
  providers: CoreProviderRegistries
  /** From server/ (P1-C1). */
  http: PluginScoped<HttpRegistry>
  /** From server/ (P1-C1). */
  ws: PluginScoped<WsRegistry>
  /** From scheduler/ (P1-G1): enqueues with `source` = plugin id. */
  deliveries: PluginScoped<DeliverySink>
  /** Backed by the `plugin_data` repository. */
  data: PluginScoped<PluginDataStore>
}

// Services

export interface CoreServiceRegistry extends PluginScoped<ServiceRegistry> {
  /** For core code; the same lookup plugins get. */
  get: ServiceRegistry['get']
  find: ServiceRegistry['find']
}

// Tools

/** `pluginId` is null for built-ins. */
export type RegisteredTool = { tool: Tool; pluginId: string | null }

export type ToolFilter = {
  /** The lowest tier among the participants: tools whose `minTier` is above it are left out. */
  tier?: Tier | undefined
  /** The focus node's capabilities: tools whose `requires` are not all in it are left out. */
  capabilities?: string[] | undefined
  /** Only these names (e.g. an agent's tool list). Unknown names are skipped. */
  names?: string[] | undefined
  /** Leave out tools in reserved namespaces (the built-ins). */
  excludeBuiltins?: boolean | undefined
}

/** One tool call as the run loop hands it to the registry. */
export type ToolInvocation = {
  toolCallId: string
  person: PersonDto
  /** `minTier` is checked against the lowest tier here. */
  participants: PersonDto[]
  threadId: ThreadId | null
  taskId: TaskId | null
  signal: AbortSignal
}

export interface CoreToolRegistry extends PluginScoped<ToolRegistry> {
  /** Privileged: built-ins in reserved namespaces (bootstrap step 10). */
  registerBuiltin(tool: Tool): void
  get(name: string): RegisteredTool | undefined
  list(filter?: ToolFilter): RegisteredTool[]
  /**
   * Validates `rawArgs` with the tool's zod schema, enforces `minTier`, applies `timeoutMs`, and
   * runs it. Never throws for tool problems: unknown tools, invalid input, tier refusals, timeouts
   * and thrown errors all come back as `{ error: true, content }` the model can read.
   */
  invoke(name: string, rawArgs: unknown, call: ToolInvocation): Promise<ToolResult>
}

// Skills and agents

export type RegisteredSkill = { skill: Skill; pluginId: string | null }

export interface CoreSkillRegistry extends PluginScoped<SkillRegistry> {
  get(name: string): RegisteredSkill | undefined
  list(): RegisteredSkill[]
}

export interface CoreAgentRegistry extends PluginScoped<AgentRegistry> {
  /** Includes the built-in `general` agent. */
  get(id: string): Agent | undefined
  list(): Agent[]
}

// Providers

export type ResolvedLlm = { provider: LlmProvider; model: string; ref: ModelRef }

export interface CoreProviderRegistries extends PluginScoped<ProviderRegistries> {
  llm: {
    /** Maps a role to its provider and model id via `config.models`. Throws `CONFIG_INVALID` for an unknown provider. */
    resolve(role: ModelRole): ResolvedLlm
    get(id: string): LlmProvider | undefined
    list(): LlmProvider[]
  }
  /** Phase 3. */
  stt: { list(): SttProvider[] }
  /** Phase 3. */
  tts: { list(): TtsProvider[] }
  /** Phase 3. */
  vad: { list(): VadProvider[] }
}
