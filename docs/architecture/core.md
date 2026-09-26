# Core: Mind, threads, scheduler

Code lives in `packages/core/src/{mind,scheduler,memory,builtins}`. Concepts come from [model.md](../concept/model.md), and behavior targets come from [scenarios.md](../concept/scenarios.md).

## Internal interfaces

Core folders depend on each other **only through these interfaces** (R-3). Lanes build against them in parallel. The blocks below are the code of each `types.ts` with its imports left out. Changing a `types.ts` needs the same change here, in the same commit (R-16).

### Shared domain types (`shared/types.ts`), implemented by `shared/` (P1-A1)

Ids, `Tier`, `TurnState`, `PersonDto` and `UiBlock` are re-exported from `@keith/protocol`; `Logger`, `Clock`, `ModelRole`, `Urgency`, `Visibility`, `DeliveryKind` and `TurnKind` from `@keith/sdk` (one definition each). `Memory` and `NewMemory` implement [memory.md](memory.md#memory-record).

```ts
export type {
  CommitmentId,
  DeliveryId,
  FileId,
  IdPrefix,
  MemoryId,
  MessageId,
  Modality,
  NodeId,
  PersonDto,
  PersonId,
  TaskId,
  ThreadId,
  Tier,
  TurnId,
  TurnState,
  UiBlock,
} from '@keith/protocol'
export type {
  Clock,
  DeliveryKind,
  LogFields,
  Logger,
  ModelRole,
  TurnKind,
  Urgency,
  Visibility,
} from '@keith/sdk'

/** Scheduler lanes. Each has its own concurrency pool (I-5). */
export type Lane = 'foreground' | 'delivery' | 'background'

/** Who a context is built for (I-3, I-4). */
export type Viewer = { participants: PersonId[] }

/** Prefixed ULID generator (R-12). */
export interface Ids {
  next<P extends IdPrefix>(prefix: P): `${P}_${string}`
}

// Tasks

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: TaskId
  personId: PersonId
  threadId: ThreadId | null
  agentId: string
  goal: string
  status: TaskStatus
  attempt: number
  /** 'subject' (direct thread) or 'thread' (group thread). */
  visibility: Visibility
  summary: string | null
  detail: string | null
  ui: UiBlock | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type TaskSpec = {
  personId: PersonId
  threadId: ThreadId | null
  agentId: string
  goal: string
  notify: 'when-done' | 'silent'
  /** User-facing wording of the commitment. Used when `notify` is 'when-done'. */
  promise?: string | undefined
}

// Commitments

export type CommitmentStatus = 'open' | 'fulfilled' | 'cancelled' | 'expired'

export interface Commitment {
  id: CommitmentId
  threadId: ThreadId
  personId: PersonId
  taskId: TaskId
  promise: string
  status: CommitmentStatus
  createdAt: number
  resolvedAt: number | null
  expiresAt: number
}

export type NewCommitment = Pick<Commitment, 'threadId' | 'personId' | 'taskId' | 'promise'>

// Deliveries

export type DeliveryStatus = 'pending' | 'delivered' | 'dismissed'

export interface Delivery {
  id: DeliveryId
  threadId: ThreadId
  personId: PersonId
  kind: DeliveryKind
  authorPersonId: PersonId | null
  /** 'core' or the plugin id. */
  source: string
  urgency: Urgency
  content: string
  ui: UiBlock | null
  status: DeliveryStatus
  createdAt: number
  deliveredAt: number | null
}

/** `threadId` defaults to the person's main thread, `source` to 'core', `urgency` to 'normal'. */
export type NewDelivery = Pick<Delivery, 'personId' | 'kind' | 'content'> &
  Partial<Pick<Delivery, 'threadId' | 'authorPersonId' | 'source' | 'urgency' | 'ui'>>

// Memories (docs/architecture/memory.md#memory-record)

export type MemorySource = 'stated' | 'inferred' | 'relayed' | 'plugin'

export interface Memory {
  id: MemoryId
  /** One fact, one sentence where possible. */
  content: string
  /** Who it is about; null = about the world or the household. */
  subjectPersonId: PersonId | null
  visibility: Visibility
  /** Required when visibility is 'thread'. */
  threadId: ThreadId | null
  source: MemorySource
  /** Who said it (null = the Mind inferred it, or a plugin wrote it). */
  authorPersonId: PersonId | null
  /** Pinned memories are part of core() for matching viewers. */
  pinned: boolean
  createdAt: number
  updatedAt: number
  lastRecalledAt: number | null
}

/** `pinned` defaults to false. */
export type NewMemory = Pick<Memory, 'content' | 'subjectPersonId' | 'visibility' | 'source'> &
  Partial<Pick<Memory, 'threadId' | 'authorPersonId' | 'pinned'>>
```

### Config (`config/types.ts`), implemented by `config/` (P1-A1)

The parsed `config.toml` ([config.md](config.md)). The zod schema that produces it lives in `config/` (P1-A1).

```ts
/** `<providerId>:<modelId>`, e.g. `deepseek:deepseek-flash`. Everything after the first `:` is the model id. */
export type ModelRef = `${string}:${string}`

export type BriefingMode = 'auto' | 'on-greeting' | 'off'

export interface KeithConfig {
  server: {
    /** Default '127.0.0.1' (R-14). */
    host: string
    /** Default 4824. */
    port: number
  }
  mind: {
    name: string
    /** IANA time zone. Default: the system time zone. */
    timezone: string
    turn: { maxSteps: number; stallMs: number }
    task: { maxSteps: number; maxPerPerson: number; timeoutMs: number }
    commitment: { ttlMs: number }
    arrival: {
      /** Fractional values allowed. */
      awayAfterMinutes: number
      briefing: BriefingMode
      holdMs: number
      graceMs: number
    }
    context: { recentMessages: number }
  }
  memory: { coreMaxChars: number }
  scheduler: { foreground: number; delivery: number; background: number; tickMs: number }
  models: Record<ModelRole, ModelRef>
  auth: { tokenTtlDays: number }
  plugins: {
    /** Package names, loaded in this order. */
    enabled: string[]
    /** The core refuses to start if one of these fails. */
    required: string[]
    stopTimeoutMs: number
    /**
     * The `[plugins."<id>"]` tables, keyed by plugin id, unvalidated. Each is validated by that
     * plugin's own `config` schema; the core never interprets them.
     */
    sections: Record<string, unknown>
  }
  /** Service name → winning plugin id, when two plugins provide the same service. */
  services: Record<string, string>
}

/** Locations inside `KEITH_HOME`. */
export interface KeithPaths {
  home: string
  configFile: string
  personaFile: string
  dbFile: string
  filesDir: string
  /** `ctx.paths.data` of a plugin is `<pluginsDir>/<plugin id>`. */
  pluginsDir: string
  logsDir: string
}

/** CLI flags that override config (highest precedence). */
export type ConfigFlags = { host?: string | undefined; port?: number | undefined }
```

### Events (`events/types.ts`), implemented by `events/` (P1-A1)

The core side of the [event bus](../contracts/events.md).

```ts
/**
 * The bus as the core uses it. The core may emit in any namespace; plugins get a scoped view
 * (`forPlugin`) that only emits in the plugin's namespace, validates payloads against schemas from
 * `define`, and tags handler errors with the plugin id.
 */
export interface CoreEventBus extends EventBus, PluginScoped<EventBus> {
  /** Resolves when every handler queued so far has run. For tests and shutdown. */
  idle(): Promise<void>
}
```

### Plugin host and registries (`plugins/types.ts`), implemented by `plugins/` (P1-A1)

The host and the core-internal registry APIs. Each registry is `PluginScoped`: plugins get a namespaced view through `forPlugin`, and a failed plugin is rolled back with `removeByPlugin`.

```ts
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
```

### Storage (`storage/types.ts`), implemented by `storage/` (P1-B1)

Repositories are the only way other folders touch the database (R-4). Tables: [storage.md](storage.md).

```ts
// persons + relationships

export interface PersonRecord {
  id: PersonId
  name: string
  /** Null for persons who cannot sign in (e.g. guests added later). Unique. */
  username: string | null
  /** Argon2id hash from `Bun.password`. */
  passwordHash: string | null
  tier: Tier
  /** Written when the person becomes away, refreshed on ticks while present. */
  lastSeenAt: number | null
  createdAt: number
}

export interface PersonsRepository {
  create(p: PersonRecord): Promise<void>
  get(id: PersonId): Promise<PersonRecord | null>
  getByUsername(username: string): Promise<PersonRecord | null>
  list(): Promise<PersonRecord[]>
  setPasswordHash(id: PersonId, passwordHash: string): Promise<void>
  setLastSeenAt(ids: PersonId[], at: number): Promise<void>
}

export interface RelationshipRecord {
  personId: PersonId
  tone: string
  notes: string
  /** Persons whose relays this person refuses (I-13, phase 5). */
  blockedRelayFrom: PersonId[]
}

export interface RelationshipsRepository {
  get(personId: PersonId): Promise<RelationshipRecord | null>
  upsert(r: RelationshipRecord): Promise<void>
}

// auth_tokens + nodes

export interface AuthTokenRecord {
  /** SHA-256 of the opaque token, hex. The token itself is never stored. */
  tokenHash: string
  personId: PersonId
  /** Filled on `hello`. */
  nodeId: NodeId | null
  expiresAt: number
  createdAt: number
}

export interface AuthTokensRepository {
  create(t: AuthTokenRecord): Promise<void>
  get(tokenHash: string): Promise<AuthTokenRecord | null>
  setNode(tokenHash: string, nodeId: NodeId): Promise<void>
  delete(tokenHash: string): Promise<void>
  /** Returns the number of deleted rows. */
  deleteExpired(now: number): Promise<number>
}

export interface NodeRecord {
  id: NodeId
  /** From `hello.client.name`. */
  name: string
  kind: 'attended' | 'headless'
  capabilities: string[]
  lastSeenAt: number | null
}

export interface NodesRepository {
  upsert(n: NodeRecord): Promise<void>
  get(id: NodeId): Promise<NodeRecord | null>
  touch(id: NodeId, at: number): Promise<void>
}

// threads + thread_participants

export interface ThreadRecord {
  id: ThreadId
  kind: 'direct' | 'group'
  /** 'main' for a person's direct thread. Unique per owner. */
  slug: string | null
  title: string
  ownerPersonId: PersonId | null
  /** Rolling summary (phase 4). */
  summary: string | null
  createdAt: number
  updatedAt: number
}

export interface ThreadParticipantRecord {
  threadId: ThreadId
  personId: PersonId
  joinedAt: number
  leftAt: number | null
}

export interface ThreadsRepository {
  /** Creates the thread and its participant rows. */
  create(t: ThreadRecord, participants: PersonId[]): Promise<void>
  get(id: ThreadId): Promise<ThreadRecord | null>
  getBySlug(ownerPersonId: PersonId, slug: string): Promise<ThreadRecord | null>
  /** Threads where the person is a current participant, most recently updated first. */
  listForPerson(personId: PersonId): Promise<ThreadRecord[]>
  /** Current participants (left_at is null). */
  participants(threadId: ThreadId): Promise<ThreadParticipantRecord[]>
  touch(id: ThreadId, updatedAt: number): Promise<void>
}

// messages (docs/architecture/storage.md#messages-and-tool-calls)

export type MessageMeta = { cancelled?: boolean | undefined; proactive?: boolean | undefined }

/** A UI block on an assistant message, with the tool that produced it (for `ui.action`). */
export type MessageUiEntry = { block: UiBlock; toolCallId: string; toolName: string }

type MessageRecordBase = {
  id: MessageId
  threadId: ThreadId
  /** Null = the Mind (I-2). */
  authorPersonId: PersonId | null
  /** The node the input came from; null for assistant and tool messages. */
  nodeId: NodeId | null
  modality: Modality
  content: string
  meta: MessageMeta | null
  createdAt: number
}

export type UserMessageRecord = MessageRecordBase & { role: 'user' }

export type AssistantMessageRecord = MessageRecordBase & {
  role: 'assistant'
  /** Set when this step called tools. Provider call ids as-is. */
  toolCalls: LlmToolCall[] | null
  ui: MessageUiEntry[] | null
}

/** Internal: never sent to nodes, replayed into `LlmMessage[]`. */
export type ToolMessageRecord = MessageRecordBase & {
  role: 'tool'
  toolCallId: string
  toolName: string
  isError: boolean
}

export type MessageRecord = UserMessageRecord | AssistantMessageRecord | ToolMessageRecord

export type MessagePage = { messages: MessageRecord[]; hasMore: boolean }

export interface MessagesRepository {
  /** Also bumps the thread's `updated_at`. */
  append(m: MessageRecord): Promise<void>
  get(id: MessageId): Promise<MessageRecord | null>
  /**
   * The `limit` messages just before `before` (or the latest), oldest first, in a stable order
   * (created_at, then id). `roles` defaults to all roles.
   */
  page(q: {
    threadId: ThreadId
    before?: MessageId | undefined
    limit: number
    roles?: MessageRecord['role'][] | undefined
  }): Promise<MessagePage>
}

// tasks, commitments, deliveries

export type TaskPatch = Partial<
  Pick<Task, 'status' | 'attempt' | 'summary' | 'detail' | 'ui' | 'startedAt' | 'finishedAt'>
>

export interface TasksRepository {
  create(t: Task): Promise<void>
  get(id: TaskId): Promise<Task | null>
  update(id: TaskId, patch: TaskPatch): Promise<void>
  /** Oldest first. */
  listByStatus(statuses: TaskStatus[]): Promise<Task[]>
  countActiveFor(personId: PersonId): Promise<number>
}

export interface CommitmentsRepository {
  create(c: Commitment): Promise<void>
  get(id: CommitmentId): Promise<Commitment | null>
  resolve(id: CommitmentId, status: Exclude<CommitmentStatus, 'open'>, resolvedAt: number): Promise<void>
  /** The open commitment linked to a task, if any. */
  openForTask(taskId: TaskId): Promise<Commitment | null>
  openForThread(threadId: ThreadId): Promise<Commitment[]>
  /** Open commitments whose `expiresAt` ≤ now. */
  listExpired(now: number): Promise<Commitment[]>
}

export interface DeliveriesRepository {
  create(d: Delivery): Promise<void>
  get(id: DeliveryId): Promise<Delivery | null>
  /** Pending deliveries of a thread, by urgency (critical first), then age. */
  pendingFor(threadId: ThreadId): Promise<Delivery[]>
  markDelivered(ids: DeliveryId[], deliveredAt: number): Promise<void>
}

// memories + memories_fts (docs/architecture/storage.md#memory-search-filter)

/** Computed by `memory/visibility.ts` (`toStorageFilter(viewer)`); storage applies it as SQL. */
export type MemoryFilter = {
  /** Every viewer participant is owner or member. */
  allowHousehold: boolean
  /** Every viewer participant is owner. */
  allowOwner: boolean
  /** Set only when the viewer has exactly one participant. */
  subjectPersonId: PersonId | null
  /** Threads that every viewer participant belongs to. */
  threadIds: ThreadId[]
}

export type MemoryPatch = Partial<Pick<Memory, 'content' | 'visibility' | 'pinned' | 'updatedAt'>>

export interface MemoriesRepository {
  create(m: Memory): Promise<void>
  get(id: MemoryId): Promise<Memory | null>
  update(id: MemoryId, patch: MemoryPatch): Promise<void>
  /** Hard delete (`memory.forget`). */
  delete(id: MemoryId): Promise<void>
  /** FTS5 search over memories the filter admits, ranked by BM25 then recency. */
  search(text: string, filter: MemoryFilter, opts?: { limit?: number | undefined }): Promise<Memory[]>
  /** Memories the filter admits, newest first. */
  list(
    filter: MemoryFilter,
    opts?: { pinned?: boolean | undefined; limit?: number | undefined },
  ): Promise<Memory[]>
  touchRecalled(ids: MemoryId[], at: number): Promise<void>
}

// plugin_data

export interface PluginDataRepository {
  get(pluginId: string, key: string): Promise<unknown>
  /** `value` must be JSON-serializable. */
  set(pluginId: string, key: string, value: unknown, updatedAt: number): Promise<void>
  delete(pluginId: string, key: string): Promise<void>
  list(pluginId: string, prefix?: string): Promise<string[]>
}

export interface Repositories {
  persons: PersonsRepository
  relationships: RelationshipsRepository
  authTokens: AuthTokensRepository
  nodes: NodesRepository
  threads: ThreadsRepository
  messages: MessagesRepository
  tasks: TasksRepository
  commitments: CommitmentsRepository
  deliveries: DeliveriesRepository
  memories: MemoriesRepository
  pluginData: PluginDataRepository
}

/** An open database. Used only by bootstrap (and test helpers); everything else gets `Repositories`. */
export interface Db {
  readonly path: string
  readonly repos: Repositories
  close(): void
}
```

### Server (`server/types.ts`), implemented by `server/` (P1-C1)

```ts
/** Constructed first; shared by server and mind (breaks the cycle). */
export interface AttachmentRegistry {
  attach(nodeId: NodeId, threadId: ThreadId): void
  /** Without `threadId`: detach the node from every thread. */
  detach(nodeId: NodeId, threadId?: ThreadId | undefined): void
  attachedTo(threadId: ThreadId): NodeId[]
  /** No-op if the node is gone. */
  send(nodeId: NodeId, frame: CoreFrame): void
}

export type NodeSink = Pick<AttachmentRegistry, 'send' | 'attachedTo'>

export interface Presence {
  isPresent(personId: PersonId): boolean
  /** Persisted in persons.last_seen_at. */
  lastSeenAt(personId: PersonId): number | null
  /** Writes last_seen_at for everyone present (shutdown). */
  flushPresence(): Promise<void>
}

/** The HTTP + WS server (bootstrap steps 9 and 12). */
export interface CoreServer {
  /** Plugin routes under `/p/<namespace>/…` (handed to the plugin host). */
  http: PluginScoped<HttpRegistry>
  /** Plugin frame types `<namespace>.*` (handed to the plugin host). */
  ws: PluginScoped<WsRegistry>
  /** Starts listening on `server.host:port`. */
  listen(): Promise<{ host: string; port: number }>
  /** Stops accepting connections and closes open sockets. */
  stop(): Promise<void>
}
```

### Mind (`mind/types.ts`), implemented by `mind/` (P1-E1)

```ts
/** `awayMs` is null on a first-ever attach. */
export type Arrival = { awayMs: number | null }

export interface OpenedThread {
  thread: ThreadDto
  messages: MessageDto[]
}

export interface ThreadManager {
  /** The server calls open() and sends the thread.opened frame itself from the return value. */
  open(a: {
    personId: PersonId
    nodeId: NodeId
    threadId?: ThreadId | undefined
    arrival: Arrival | null
  }): Promise<OpenedThread>
  detach(a: { nodeId: NodeId; threadId?: ThreadId | undefined }): void
  input(a: {
    threadId: ThreadId
    personId: PersonId
    nodeId: NodeId
    modality: Modality
    text: string
  }): Promise<void>
  cancel(a: { threadId: ThreadId; nodeId: NodeId }): void
  state(threadId: ThreadId): TurnState
}

export type RunLoopArgs = {
  system: string
  messages: LlmMessage[]
  /** Tool names. */
  tools: string[]
  modelRole: ModelRole
  maxSteps: number
  runCtx: { personId: PersonId; participants: PersonId[]; threadId: ThreadId | null; taskId: TaskId | null }
  /** Null = don't write tool messages to a thread (tasks). */
  persist: { threadId: ThreadId } | null
  signal: AbortSignal
  /** The caller turns these into frames; RunLoop never sends frames. */
  onEvent?: ((e: RunLoopEvent) => void) | undefined
}

export type RunLoopResult = { text: string; steps: number; stoppedBy: 'stop' | 'step_limit' | 'cancelled' }

/**
 * A pure function built from registries and repositories. Used by the mind for turns and by the
 * scheduler for tasks.
 */
export type RunLoop = (a: RunLoopArgs) => Promise<RunLoopResult>

export type RunLoopEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.completed'; toolCallId: string; name: string; ok: boolean; summary?: string | undefined }
  | { type: 'ui'; toolCallId: string; toolName: string; block: UiBlock; fallbackText: string }
  | { type: 'step.completed'; step: number }

/** What the context builder produces for one turn. */
export type BuiltContext = { system: string; messages: LlmMessage[]; tools: string[] }

/**
 * Builds `{ system, messages, tools }` for a turn: the nine system-prompt sections in core.md
 * order, the recent-messages window, and the tools the viewer may use.
 */
export interface ContextBuilder {
  build(a: {
    threadId: ThreadId
    viewer: Viewer
    kind: TurnKind
    /** The focus node's capabilities (section 2, and tool filtering). */
    focusCapabilities: string[]
    /** Section 8. Only for delivery and briefing turns, and the first turn after an arrival. */
    deliveries: Delivery[]
  }): Promise<BuiltContext>
}
```

The ThreadManager maps `RunLoopEvent`s to `message.delta`, `tool.activity` and `ui.render` frames. The scheduler ignores most of them for tasks (it keeps `ui` for the task result).

### Scheduler (`scheduler/types.ts`), implemented by `scheduler/` (P1-G1)

```ts
export interface Scheduler {
  run<T>(lane: Lane, job: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}

export interface TaskService {
  start(spec: TaskSpec): Promise<Task>
  cancel(id: TaskId): Promise<void>
  get(id: TaskId): Promise<Task | null>
  active(): Promise<Task[]>
}

export interface CommitmentService {
  create(c: NewCommitment): Promise<Commitment>
  resolveForTask(taskId: TaskId, outcome: 'fulfilled' | 'cancelled'): Promise<Commitment | null>
  openFor(threadId: ThreadId): Promise<Commitment[]>
}

export interface DeliveryQueue {
  /** Persists, then emits `delivery.enqueued`. */
  enqueue(d: NewDelivery): Promise<Delivery>
  /** Ordered by urgency, then age. */
  pendingFor(threadId: ThreadId): Promise<Delivery[]>
  markDelivered(ids: DeliveryId[], messageId: MessageId): Promise<void>
}
```

### Memory (`memory/types.ts`), implemented by `memory/` (P1-M1)

```ts
export interface MemoryService {
  write(m: NewMemory): Promise<Memory>
  recall(q: { text: string; viewer: Viewer; limit?: number | undefined }): Promise<Memory[]>
  /** Pinned, visible, capped by `memory.coreMaxChars`. */
  core(viewer: Viewer): Promise<Memory[]>
  /** Subjects and topics that exist but are not in core(). */
  index(viewer: Viewer): Promise<string[]>
  /** Awareness digest, at most 5 lines. */
  digest(a: { threadId: ThreadId; viewer: Viewer }): Promise<string>
}
```

The digest builds its activity picture from events (`thread.state_changed`, `task.*`) plus repositories. It never calls the mind, so there is no cycle.

### Construction order (bootstrap)

The only order that has no cycles. `bootstrap.ts` follows it:

1. config → logger, clock, ids
2. db + repositories → event bus
3. registries: services, tools, skills, agents, providers (standalone objects from `plugins/`)
4. `AttachmentRegistry` + `Presence` (from `server/`)
5. `RunLoop` (from `mind/`, needs providers, tools, repositories)
6. scheduler, tasks, commitments, deliveries (needs `RunLoop`)
7. memory (needs repositories, events, tasks)
8. `ThreadManager` (needs everything above). It subscribes to `delivery.enqueued`, so nothing calls into it from below. Arrival reaches it only through `open({ arrival })`, never through the `person.arrived` event (which is for plugins).
9. server (needs `ThreadManager`, attachments, presence) builds its http and ws registries, **without listening yet**
10. built-in tools registered through the privileged `tools.registerBuiltin()`
11. plugin host (needs registries, server http/ws, the delivery sink) → load → `setup` → `start`
12. server `listen()` → emit `core.started`

## Threads and turn state

Each Thread has one `TurnState` held in memory (not persisted) and broadcast as `thread.state` frames. Direct threads are created on demand: `open` without a `threadId` gets or creates the person's direct thread with slug `main`.

```
          input.text / audio start
   idle ───────────────────────────► thinking ──first text delta──► speaking
    ▲  ▲                                 │                             │
    │  └──────── turn ends ──────────────┴─────────────────────────────┘
    │
    └─ listening (voice only, phase 3): VAD detected speech on the focus node
```

Rules:
- **Input while `thinking` or `speaking`.** Text input is queued and becomes the next turn. Nothing is lost, and the model sees both messages. Voice barge-in is phase 3.
- **`input.cancel`** aborts the running turn's `AbortSignal`. The partial assistant text is persisted with `meta.cancelled = true`.
- **Focus** is set to the node of each new input. Audio output goes to the focus node only. Text and UI go to every node attached to the Thread (I-7).
- Each new user input is echoed to the *other* attached nodes as `message.user`.
- **Queue details.** One turn runs per thread at a time. Inputs that arrive while a turn runs wait in a FIFO; when the turn ends, *all* waiting inputs become the next turn together. A queued input is echoed right away but persisted when its turn starts, so history reads `user → reply → next user` rather than two user messages before the reply.
- **Focus fallback.** When the focus node detaches, focus is empty until the next input; a turn without focus uses the capabilities of the first attached node.

## The turn loop

One function, `RunLoop`, powers user turns, delivery turns, briefing turns and tasks. What differs is the context and the model role.

```
runLoop({ system, messages, tools, modelRole, maxSteps, runCtx, persist, signal, onEvent }):
  for step in 1..maxSteps:
    stream = providers.llm.resolve(modelRole).stream({ system, messages, tools }, signal)
    forward text deltas → onEvent ; collect tool calls
    if no tool calls: return final text
    run tool calls through tools.invoke (in parallel, each with its own timeout)
    append the assistant message (with toolCalls) + one tool message per call ; persist if `persist`
  return final text, stoppedBy 'step_limit'
```

- **Step limit:** `mind.turn.maxSteps` (default 8) for turns, `mind.task.maxSteps` (default 20) for tasks.
- **Stall watchdog:** a step with no stream event for `mind.turn.stallMs` (default 120 000) is aborted and reported.
- **Tool errors** never crash a turn. The error text becomes the tool result so the model can recover. Unknown tools, invalid arguments and tier refusals are handled the same way.
- **Tool tier check:** `tools.invoke` enforces `tool.minTier` against the **lowest tier among `runCtx.participants`** (for tasks, the task's person).
- **Provider errors:** retryable ones (network, 429, 5xx) are retried by the loop up to 2 times with backoff, then surface as an `error` frame plus a short assistant apology message.
- **Tool call ids:** the provider's `LlmToolCall.id` is persisted as-is. See [storage.md](storage.md#messages-and-tool-calls).
- A tool result's `ui` block is persisted on the assistant message and sent as a `ui.render` frame to attached nodes that declared `ui.render@1`. The model only ever sees `content` (text).
- **Messages of a turn.** Nodes see one assistant message per turn (the `messageId` of `message.started`); its content is all text streamed in the turn and it carries the turn's `ui` entries. When `persist` is set, the loop also stores each tool step as an assistant row with `toolCalls` plus one `tool` row per call. Those rows are replayed to the model but hidden from nodes (history and `thread.opened` skip them). History is ordered by `(createdAt, id)`. The turn's message gets its id when the turn starts, before the tool-step rows, and a queued input gets its id when it arrives, so when the ThreadManager stores either one and it would sort before the thread's latest row (same millisecond), it stamps it one millisecond after that row.
- **Retry and stall details.** A retryable provider error is retried only before the step's first text or tool event (otherwise the node would see text twice). A stalled step is not retried: it fails the turn with `PROVIDER_ERROR`. A failed turn keeps any partial text and appends the apology.
- **Replay window.** The recent-messages window may cut a tool step in half. Orphan `tool` rows are dropped, and an assistant row whose calls lack results is replayed as plain text.

## Context builder

Builds `{ system, messages, tools }` for a Viewer. The system prompt is assembled in this order. Each section is a separate, testable function:

1. **Persona:** `~/.keith/persona.md` (see [config.md](config.md)).
2. **Now:** current date/time and timezone, plus the focus node's capabilities (so the model knows whether it can show UI or is being heard).
3. **Participants:** each participant's relationship card (name, tier, tone, notes).
4. **Core memories:** `MemoryService.core(viewer)`.
5. **Memory index:** `MemoryService.index(viewer)`, so the model knows recall is worth trying.
6. **Awareness digest:** `MemoryService.digest(...)`, 5 lines at most.
7. **Open commitments** in this Thread.
8. **Pending deliveries:** only in delivery turns and arrival turns, with instructions to phrase them naturally.
9. **Skills index:** name + one-line description of every registered skill (full text loads through `skill.load`).

**Messages:** the last `mind.context.recentMessages` messages (default 40). A running thread summary is added in phase 4.

**Tools:** built-ins, plus registry tools where `tool.minTier` is at or below the lowest participant tier (owner > member > guest) and `tool.requires ⊆` the focus node's capabilities.

## Scheduler

Three lanes, each with its own concurrency limit. Separate pools make I-5 structural rather than a matter of priority tuning. A **job** is any unit of work the scheduler runs: a turn or a task step.

| Lane | Used by | Default concurrency (config key) |
|---|---|---|
| `foreground` | User turns | 4 (`scheduler.foreground`) |
| `delivery` | Delivery and briefing turns | 2 (`scheduler.delivery`) |
| `background` | Tasks, reflection (phase 4) | 2 (`scheduler.background`) |

A **tick** fires every `scheduler.tickMs` (default 30 000) and emits `scheduler.ticked`. Plugins, commitment expiry and phase-4 reminders use it. Jobs in one lane never wait on another lane's pool. Within a lane, waiting jobs start in FIFO order. A job whose `signal` aborts while it waits leaves the queue, and `run` rejects with the signal's reason.

## Tasks

A Task is background work run with an Agent.

- Started by the built-in tool `task.start({ agent?, goal, notify, promise? })`. `notify` is `'when-done'` (creates a Commitment) or `'silent'`. `agent` defaults to the built-in `general`, whose tools are every non-reserved registry tool plus `memory.recall`, `memory.remember` and `skill.load`. Plugins add agents through the agent registry.
- **Task context:** the Agent's system prompt + a short persona line + the goal + the task person's relationship card. Tasks don't get thread history. They use `memory.recall` when they need more. The task runs `RunLoop` with the Agent's tools, the `background` model role, `persist: null`, and `runCtx.participants = [personId]` (the group's participants in phase 5).
- **Visibility:** `subject` when started in a direct thread, `thread` when started in a group thread.
- **v1 limits:** tasks cannot start tasks, at most `mind.task.maxPerPerson` (default 3) active (`queued` or `running`) per Person, and a timeout of `mind.task.timeoutMs` (default 1 800 000), counted from the moment the task starts running. Over the limit, `task.start` returns a tool error (`TASK_LIMIT_REACHED`) the model can read. A timeout fails the task.
- **Status:** `queued → running → completed | failed | cancelled`. On core start, tasks left `queued` are scheduled again, and tasks left `running` are re-queued once (`attempt` 2). A second interruption fails them. A graceful shutdown aborts running tasks without changing their stored status, so the next start recovers them. A run that ends with empty text counts as failed.
- The result is stored on the task as `summary` (the result text cut to 500 characters, for contexts and deliveries) plus `detail` (full text) plus optional `ui` (the last `ui` block the run produced).
- `task.status` shows one task (with its result) or lists the caller's active tasks. `task.status` and `task.cancel` only see tasks of the calling person, or tasks started in the current group thread. The three `task.*` tools require tier `member`. In phase 1, results are *not* written as memories. They reach later contexts through the delivery message in thread history and through `task.status`. Phase 4 reflection distills them.
- Emits `task.started`, `task.completed`, `task.failed`, `task.cancelled`.

## Commitments

- Created by `task.start` when `notify = 'when-done'`, with `promise` holding the user-facing wording. `TaskService.start` creates it before the task is scheduled, so a fast task never misses it. A task started without a thread promises in the person's `main` thread.
- `open → fulfilled | cancelled | expired`. Expiry is `mind.commitment.ttlMs` (default 604 800 000 = 7 days) without resolution, checked on tick (I-10).
- When a task ends:
  - completed → commitment `fulfilled` + a `task_result` Delivery
  - failed → commitment `fulfilled` (the promise to *report back* is kept) + a `task_failed` Delivery with an apology
  - cancelled by the person → commitment `cancelled`, no Delivery

## Deliveries

A Delivery is anything the Mind should surface in a Thread without being asked.

| Kind | Source | Phase |
|---|---|---|
| `task_result` / `task_failed` | Commitment resolution | 1 |
| `plugin` | `ctx.deliveries.enqueue` from a `tool` or `client-app` plugin | 1 |
| `reminder` | `reminder.set` built-in | 4 |
| `relay` | `relay.send` built-in (I-13) | 5 |
| `invitation` | `thread.start_group` | 5 |

**Enqueueing.** `DeliveryQueue.enqueue` persists the item and emits `delivery.enqueued`; it never calls the Mind. Without a `threadId` it targets the person's `main` thread and fails with `NOT_FOUND` if that thread doesn't exist yet. A task's delivery goes to its commitment's thread; `silent` tasks have no commitment and deliver nothing. The plugin sink (`ctx.deliveries`) validates the input with zod, refuses (`FORBIDDEN`) a `threadId` the person doesn't participate in, and records `source` = the plugin id.

**Flush triggers.** The ThreadManager checks the queue when (a) a `delivery.enqueued` event arrives for a thread, (b) a turn ends, (c) an arrival's hold ends (below), and (d) `open` is called and no hold starts (a reconnect below the threshold, or `briefing = off`). It flushes only when the thread is `idle`, the person is present, and no arrival hold is active.

**Delivery turn.** Runs in the `delivery` lane. All pending items go into context at once (section 8), ordered by urgency. Frames are `proactive: true`. After the assistant message is persisted, every item that was in context is marked delivered (with that `messageId`), whether or not the model mentioned it. `critical` items flush before any queued user input.

**Away.** Deliveries wait until the person is present again.

**Flush details.** Trigger (d) runs on the next macrotask after `open` returns, so the server sends `thread.opened` before any turn frame. Items in a delivery turn are marked delivered only if the turn completed; after a failed or cancelled turn the flush waits for the next trigger (no retry loop).

## Presence and arrival

- A Person is **present** while at least one attended node has one of their Threads open. `persons.last_seen_at` is written when they become away, refreshed on every scheduler tick while they are present, and written for every present person on graceful shutdown. Arrival detection survives restarts and crashes, and a crash costs at most one tick of accuracy.
- The server decides arrival when a person's first node attaches: `awayMs = now − last_seen_at`. It is an arrival if `awayMs ≥ mind.arrival.awayAfterMinutes × 60 000` (fractional minutes allowed), or if `last_seen_at` is null (first-ever attach, `awayMs: null`, a first meeting). The server then passes `arrival` to `ThreadManager.open` and emits `person.arrived`. Plugins may enqueue Deliveries in response (news, weather).
- `mind.arrival.briefing` controls what happens on arrival:
  - `on-greeting` (default): an **arrival hold** starts, and no delivery turn runs. The first user turn after arrival gets all pending deliveries in context (section 8). If the input is a greeting or a catch-up question, the model leads with them. Otherwise it answers first and then mentions them briefly. After that turn's reply is persisted, the included items are marked delivered. If no input arrives within `mind.arrival.holdMs` (default 120 000), the hold ends and a normal delivery turn runs.
  - `auto`: after a grace period of `mind.arrival.graceMs` (default 1 500, so plugin deliveries can land), a briefing turn runs in the delivery lane. It is a delivery turn whose instructions also say to greet.
  - `off`: no hold, normal flush.
- The `auto` grace period works like a short hold: deliveries that land during it wait for the briefing. Input during an `on-greeting` hold or an `auto` grace ends it, and that user turn carries the pending deliveries (the briefing turn is skipped).

## Built-in tools

Registered with `tools.registerBuiltin()`. Their namespaces are reserved.

| Tool | Phase | Purpose |
|---|---|---|
| `task.start`, `task.status`, `task.cancel` | 1 | Background work |
| `skill.load` | 1 | Load a skill's full instructions |
| `memory.remember`, `memory.recall`, `memory.forget` | 1 (FTS), 4 (reflection) | Write, search and delete memories |
| `reminder.set`, `reminder.cancel` | 4 | Time-based deliveries |
| `relay.send` | 5 | S-5 |
| `thread.start_group`, `thread.invite`, `thread.leave` | 5 | S-6 |

> Planned (phase 5): **Group threads.** Participants are stored from phase 1 (`thread_participants`), and messages carry `authorPersonId` from phase 1. Phase 5 adds the addressing detector (a rule-based pass, then a `utility`-model fallback), a turn for human-to-human messages that only fans out (no LLM), `thread` visibility for memories written in the group, and invitation deliveries. See [scenarios.md S-6](../concept/scenarios.md#s-6-collaboration-a-group-thread-with-shared-state).
