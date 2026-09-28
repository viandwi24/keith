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
  ReminderId,
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

// Reminders (phase 4, docs/architecture/core.md#reminders)

export type ReminderStatus = 'pending' | 'fired' | 'cancelled'

export interface Reminder {
  id: ReminderId
  personId: PersonId
  /** Where it is delivered; null = the person's `main` thread. */
  threadId: ThreadId | null
  /** What to remind of, 1..500 characters. */
  text: string
  /** When it is due (ms, UTC). It fires on the first scheduler tick at or after this time. */
  dueAt: number
  status: ReminderStatus
  createdAt: number
  firedAt: number | null
  cancelledAt: number | null
  /** The `reminder` delivery it fired as; null until fired. */
  deliveryId: DeliveryId | null
}

// Group invitations (phase 5, docs/architecture/core.md#group-threads)

export type ThreadInvitationStatus = 'pending' | 'accepted' | 'declined'

/** An invitation of a person to a group thread. One row per (thread, person). */
export interface ThreadInvitation {
  threadId: ThreadId
  personId: PersonId
  /** The current participant who invited them. */
  invitedBy: PersonId
  status: ThreadInvitationStatus
  /** The `invitation` delivery in the invitee's main thread; null when it is gone or not made yet. */
  deliveryId: DeliveryId | null
  createdAt: number
  /** When it became `accepted` or `declined`; null while `pending`. */
  resolvedAt: number | null
}

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

/** Phase 5: how the Mind decides whether a group input is addressed to it. */
export type GroupAddressingMode = 'rules+utility' | 'rules'

export interface KeithConfig {
  server: {
    /** Default '127.0.0.1' (R-14). */
    host: string
    /** Default 4824. */
    port: number
    /**
     * Phase 5: the base URL people use to reach this Keith, e.g. 'https://keith.example.net'. Invite
     * links are `<publicUrl>/#invite=<code>`. Optional: absent means `http://<host>:<port>`.
     */
    publicUrl?: string | undefined
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
    /** Phase 4: `[mind.reminder]`. */
    reminder: {
      /** Pending reminders per person. Default 50. */
      maxPerPerson: number
    }
    /** Phase 5: `[mind.group]`, group threads (ADR-0017). */
    group: {
      /** Current participants plus pending invitations. Default 8, at least 2. */
      maxParticipants: number
      /** Invitees with tier `member` or higher join at once. Guests always accept. Default false. */
      autoJoin: boolean
      /** 'rules+utility' (default): the rule pass, then the `utility` model for unsure inputs. 'rules': no model. */
      addressing: GroupAddressingMode
    }
  }
  memory: {
    coreMaxChars: number
    /** Phase 4: `[memory.reflect]`, the reflection job (ADR-0014). */
    reflect: {
      /** Default true. */
      enabled: boolean
      /** A thread is reflected after this long without a stored message. Fractional allowed. Default 20. */
      idleMinutes: number
      /** Messages read per pass; more wait for the next pass. Default 200. */
      maxMessages: number
      /** Cap on `relationships.notes` written by reflection. Default 1000. */
      cardMaxChars: number
    }
    /** Phase 4: `[memory.summary]`, the thread summary job (ADR-0014). */
    summary: {
      /** Default true. */
      enabled: boolean
      /** Rows out of the recent-messages window before the summary is updated. Default 20. */
      minMessages: number
      /** Cap on `threads.summary`. Default 2000. */
      maxChars: number
    }
  }
  scheduler: { foreground: number; delivery: number; background: number; tickMs: number }
  models: Record<ModelRole, ModelRef>
  auth: {
    tokenTtlDays: number
    /** Phase 5: invite links expire after this many hours. Fractional allowed. Default 72. */
    inviteTtlHours: number
  }
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
  /** Phase 3: the `[voice]` section. Absent (undefined) = voice is off. */
  voice?: VoiceConfig | undefined
}

/** `[voice]`: which registered providers run the pipeline (ADR-0013), and turn-taking knobs. */
export interface VoiceConfig {
  /** `VadProvider` id, e.g. 'energy'. */
  vad: string
  /** `SttProvider` id, e.g. 'groq', 'speaches'. */
  stt: string
  /** `TtsProvider` id, e.g. 'openai', 'speaches'. */
  tts: string
  /** Passed to STT and TTS as a hint, e.g. 'en'. Omitted: providers detect it. */
  language?: string | undefined
  /** An utterance longer than this goes to STT anyway. Default 30000. */
  maxUtteranceMs: number
  /** Speech on the focus node while `thinking` or `speaking` interrupts the reply. Default true. */
  bargeIn: boolean
  /**
   * Speech must last this long before it counts as a barge-in. Default 600: above the energy VAD's
   * 500 ms hangover, so a short noise has ended (`speaking: false`) before it would count.
   */
  bargeInMinMs: number
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
  /**
   * Phase 4: registers a core **default** skill (owner `core`, `pluginId` null). A plugin that
   * registers a skill with the same name replaces the default instead of failing with
   * `TOOL_NAME_TAKEN`, and `removeByPlugin` brings the default back. Registering a default twice
   * with the same name throws `TOOL_NAME_TAKEN`. The name pattern applies as for plugins.
   */
  registerDefault(skill: Skill): void
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
  /**
   * Phase 5: the person called `name`. Trims `name`, then matches it against `name`
   * case-insensitively, then against `username` case-insensitively. Null when nothing matches or
   * `name` is empty after trimming. Names are unique case-insensitively (`keith person add`
   * enforces it), so a name matches at most one person; a name match wins over a username match.
   */
  findByName(name: string): Promise<PersonRecord | null>
  /** Phase 5: sets the tier. An unknown id is a no-op. The callers keep exactly one owner (ADR-0017). */
  setTier(id: PersonId, tier: Tier): Promise<void>
  /**
   * Phase 5: sets the username and the password hash together (accepting an invite link). The
   * caller checks that no other person has `username` (`getByUsername`); storing a username that
   * another person has throws. An unknown id is a no-op.
   */
  setCredentials(id: PersonId, c: { username: string; passwordHash: string }): Promise<void>
  /**
   * Phase 5: deletes the person in one transaction, exactly as ADR-0018 lists
   * (docs/decisions/0018-deleting-a-person.md), and returns what it did. Throws
   * `KeithError('FORBIDDEN')` for the owner and `KeithError('NOT_FOUND')` for an unknown id; then
   * nothing changes. The stored file bytes are not touched: the caller deletes `filePaths` after
   * the commit.
   */
  remove(id: PersonId): Promise<PersonRemoval>
}

/** Phase 5: what `PersonsRepository.remove` did. Every count is a number of rows. */
export interface PersonRemoval {
  deleted: {
    /** Their direct threads (`kind = 'direct'`, owned by them). */
    directThreads: number
    /** Messages in their direct threads. */
    directMessages: number
    /** Their own messages in group threads. */
    groupMessages: number
    /** Their participant rows in group threads (they leave every group). */
    groupMemberships: number
    /** Memories about them (any visibility) and `thread` memories of their direct threads. */
    memories: number
    tasks: number
    commitments: number
    /** Deliveries addressed to them, in their direct threads, and their pending relays. */
    deliveries: number
    reminders: number
    authTokens: number
    inviteLinks: number
    /** Group invitations to or from them. */
    threadInvitations: number
    /** File rows they uploaded. */
    files: number
  }
  /** Rows kept, with the reference to the person cleared. */
  cleared: {
    /** Memories they authored about someone else or nobody (`author_person_id` → null). */
    memories: number
    /** Delivered relays they sent (`author_person_id` → null). */
    relays: number
    /** Group threads they created (`owner_person_id` → null). */
    groupThreads: number
    /** Other people's relationship cards whose `blockedRelayFrom` named them. */
    blockLists: number
  }
  /** The deleted files' paths, relative to `KEITH_HOME/files/`, for the caller to delete. */
  filePaths: string[]
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
  /** Rolling summary (phase 4), written by `setSummary`. */
  summary: string | null
  createdAt: number
  updatedAt: number
  /**
   * Phase 4: the last message `seq` that `summary` covers; null = no summary yet. Set on every
   * record `get`, `getBySlug` and `listForPerson` return. Optional only so existing record
   * literals (and `create` input) compile without it; `create` stores it as given (absent = null).
   */
  summaryThroughSeq?: number | null | undefined
  /**
   * Phase 4: the last message `seq` that reflection has read; null = never reflected. Same rules
   * as `summaryThroughSeq`.
   */
  reflectedThroughSeq?: number | null | undefined
  /**
   * Phase 5: what a group thread is for; null for direct threads and groups without one. Set on
   * every record `get`, `getBySlug` and `listForPerson` return. Optional only so existing record
   * literals compile without it; `create` stores it as given (absent = null).
   */
  purpose?: string | null | undefined
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
  /**
   * Phase 4: stores the rolling summary and the last message `seq` it covers
   * (`summaryThroughSeq`). Does not touch `updated_at`. A missing thread is a no-op.
   */
  setSummary(id: ThreadId, s: { summary: string; throughSeq: number }): Promise<void>
  /**
   * Phase 4: moves the reflection cursor (`reflectedThroughSeq`) to `seq`. Does not touch
   * `updated_at`. A missing thread is a no-op.
   */
  setReflectedThrough(id: ThreadId, seq: number): Promise<void>
  /**
   * Phase 5: makes the person a current participant. Inserts a row (`joinedAt = at`), or, for a
   * former participant, clears `leftAt` and sets `joinedAt = at` on their row. Returns false (and
   * changes nothing) when the person is already a current participant.
   */
  addParticipant(threadId: ThreadId, personId: PersonId, at: number): Promise<boolean>
  /**
   * Phase 5: sets `leftAt = at` on the person's row if they are a current participant. Returns
   * whether a current participant left (false: not a participant, or already left).
   */
  removeParticipant(threadId: ThreadId, personId: PersonId, at: number): Promise<boolean>
  /** Phase 5: participant rows with `leftAt` set, most recent `leftAt` first (ties by person id). */
  formerParticipants(threadId: ThreadId): Promise<ThreadParticipantRecord[]>
  /**
   * Phase 4: threads that are due for reflection: `updated_at ≤ idleBefore` and at least one
   * message whose `seq` is greater than the reflection cursor (null counts as 0). Oldest
   * `updated_at` first (ties by id), at most `limit`. `lastSeq` is the thread's highest message
   * `seq`.
   */
  listForReflection(q: {
    idleBefore: number
    limit: number
  }): Promise<{ thread: ThreadRecord; lastSeq: number }[]>
}

// messages (docs/architecture/storage.md#messages-and-tool-calls)

export type MessageMeta = {
  cancelled?: boolean | undefined
  proactive?: boolean | undefined
  /** Phase 3: a spoken reply cut by barge-in; `content` holds only this many characters. */
  spokenChars?: number | undefined
  /**
   * Phase 5: on an assistant message whose delivery turn carried relays, one entry per sender, in
   * delivery order (I-13). `name` is the name the recipient saw, kept when the sender is renamed
   * or deleted.
   */
  relayFrom?: { personId: PersonId; name: string }[] | undefined
}

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
  /**
   * Position in the thread: per thread, strictly increasing, assigned by the repository on
   * insert (`append` ignores a value passed in). It defines message order; `createdAt` does not.
   * Set on every record `get` and `page` return. Optional only so callers can build a record
   * for `append` without one.
   */
  seq?: number | undefined
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
  /** Assigns `seq`. Also bumps the thread's `updated_at`. */
  append(m: MessageRecord): Promise<void>
  get(id: MessageId): Promise<MessageRecord | null>
  /**
   * The `limit` messages just before `before` (or the latest), oldest first, in `seq` order.
   * `roles` defaults to all roles.
   */
  page(q: {
    threadId: ThreadId
    before?: MessageId | undefined
    limit: number
    roles?: MessageRecord['role'][] | undefined
  }): Promise<MessagePage>
  /**
   * Phase 4: the first `limit` messages with `seq > afterSeq`, ascending by `seq`, each with its
   * `seq` set. `roles` (default: all roles) filters the rows before the limit applies, so rows of
   * other roles are skipped without counting.
   */
  range(q: {
    threadId: ThreadId
    afterSeq: number
    limit: number
    roles?: MessageRecord['role'][] | undefined
  }): Promise<MessageRecord[]>
  /** Phase 4: the thread's highest message `seq`, all roles; 0 when the thread has no messages. */
  lastSeq(threadId: ThreadId): Promise<number>
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

/** A stored delivery: the domain `Delivery` plus the message that delivered it. */
export type DeliveryRecord = Delivery & {
  /**
   * The assistant message whose turn delivered the item. Null (or absent) while pending, and for
   * items delivered before this column existed.
   */
  messageId?: MessageId | null | undefined
}

export interface DeliveriesRepository {
  create(d: Delivery): Promise<void>
  get(id: DeliveryId): Promise<DeliveryRecord | null>
  /** Pending deliveries of a thread, by urgency (critical first), then age. */
  pendingFor(threadId: ThreadId): Promise<Delivery[]>
  /** Only changes `pending` rows. `messageId`: the message that delivered them, stored on each. */
  markDelivered(ids: DeliveryId[], deliveredAt: number, messageId?: MessageId | undefined): Promise<void>
}

// reminders (phase 4)

export interface RemindersRepository {
  /** Stores the reminder as given (normally `pending`, with null `firedAt`/`cancelledAt`/`deliveryId`). */
  create(r: Reminder): Promise<void>
  get(id: ReminderId): Promise<Reminder | null>
  /**
   * `pending` reminders with `dueAt ≤ now`, soonest first (ties by id). `limit` caps the result;
   * omitted = all.
   */
  listDue(now: number, limit?: number | undefined): Promise<Reminder[]>
  /** The person's `pending` reminders, soonest first (ties by id). */
  listPending(personId: PersonId): Promise<Reminder[]>
  /** How many `pending` reminders the person has. */
  countPending(personId: PersonId): Promise<number>
  /**
   * Sets `status = 'fired'`, `firedAt = at` and `deliveryId`, only if the reminder is `pending`.
   * Returns whether a row changed (false: unknown id, or already fired or cancelled).
   */
  markFired(id: ReminderId, at: number, deliveryId: DeliveryId): Promise<boolean>
  /**
   * Sets `status = 'cancelled'` and `cancelledAt = at`, only if the reminder is `pending`.
   * Returns whether a row changed (false: unknown id, or already fired or cancelled).
   */
  cancel(id: ReminderId, at: number): Promise<boolean>
}

// thread_invitations (phase 5)

export interface ThreadInvitationsRepository {
  /**
   * Stores `inv` (normally `pending`, with null `resolvedAt`). When a `declined` row exists for the
   * same thread and person, it is replaced (a re-invitation). Returns false, and changes nothing,
   * when a `pending` or `accepted` row exists.
   */
  create(inv: ThreadInvitation): Promise<boolean>
  get(threadId: ThreadId, personId: PersonId): Promise<ThreadInvitation | null>
  /** The thread's `pending` invitations, oldest first (ties by person id). */
  pendingForThread(threadId: ThreadId): Promise<ThreadInvitation[]>
  /** The person's `pending` invitations, oldest first (ties by thread id). */
  pendingForPerson(personId: PersonId): Promise<ThreadInvitation[]>
  /**
   * Sets `status` and `resolvedAt = at`, only on a `pending` row. Returns whether a row changed
   * (false: no invitation, or already accepted or declined).
   */
  resolve(
    threadId: ThreadId,
    personId: PersonId,
    status: Exclude<ThreadInvitationStatus, 'pending'>,
    at: number,
  ): Promise<boolean>
}

// invite_links (phase 5)

export interface InviteLinkRecord {
  /** SHA-256 of the code's UTF-8 bytes, hex. The code itself is never stored (R-14). */
  codeHash: string
  personId: PersonId
  createdAt: number
  expiresAt: number
  /** When the link was accepted; null while unused. */
  usedAt: number | null
}

export interface InviteLinksRepository {
  create(l: InviteLinkRecord): Promise<void>
  /** The link, used or not, expired or not; null for an unknown hash. */
  get(codeHash: string): Promise<InviteLinkRecord | null>
  /**
   * Sets `usedAt = at`, only on an unused row. Returns whether a row changed (false: unknown hash,
   * or already used), so two requests with one code can't both win.
   */
  markUsed(codeHash: string, at: number): Promise<boolean>
  /** Deletes the person's unused links (used ones stay). Returns the number of deleted rows. */
  revokeFor(personId: PersonId): Promise<number>
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

// files (phase 2)

export interface FileRecord {
  id: FileId
  /** Original file name. */
  name: string
  /** Path relative to `KEITH_HOME/files/`. */
  path: string
  mime: string
  size: number
  ownerPersonId: PersonId
  createdAt: number
}

export interface FilesRepository {
  create(f: FileRecord): Promise<void>
  get(id: FileId): Promise<FileRecord | null>
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
  files: FilesRepository
  /** Phase 4. */
  reminders: RemindersRepository
  /** Phase 5. */
  threadInvitations: ThreadInvitationsRepository
  /** Phase 5. */
  inviteLinks: InviteLinksRepository
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
  /**
   * Phase 5: the person's connected attended nodes, in connect order, whether or not they have a
   * thread open (for `thread.updated` / `thread.removed`).
   */
  nodesOfPerson(personId: PersonId): NodeId[]
  /** No-op if the node is gone. */
  send(nodeId: NodeId, frame: CoreFrame): void
  /** Phase 3: a binary frame (`encodeAudioFrame` output) to one node. No-op if the node is gone. */
  sendBinary(nodeId: NodeId, bytes: Uint8Array): void
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
  /**
   * The server calls open() and sends the thread.opened frame itself from the return value.
   * `messages` holds at most `historyLimit` visible messages (0..200, default 50; the
   * `thread.open` value as-is), oldest first.
   */
  open(a: {
    personId: PersonId
    nodeId: NodeId
    threadId?: ThreadId | undefined
    arrival: Arrival | null
    historyLimit?: number | undefined
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
  /**
   * A `ui.action` from a node (phase 2). Finds the block in the message's persisted `ui` entries,
   * then calls its tool's `onAction` or runs the input "(clicked: <label>)". Throws
   * `KeithError('NOT_FOUND')` for an unknown message, block or action.
   */
  action(a: {
    threadId: ThreadId
    personId: PersonId
    nodeId: NodeId
    messageId: MessageId
    blockId: string
    actionId: string
    value?: unknown
  }): Promise<void>
  /**
   * Phase 3: the voice pipeline's VAD saw speech start or stop on a node's audio stream.
   * `speaking: true` moves an idle thread to `listening`, and on the focus node while `thinking`
   * or `speaking` it is a barge-in (the turn is cancelled and speech output stopped).
   * `speaking: false` without a following input returns `listening` to `idle`.
   */
  voiceActivity(a: { threadId: ThreadId; nodeId: NodeId; speaking: boolean }): void
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

// Group threads (phase 5, docs/architecture/core.md#group-threads)

export type AddressingVerdict = {
  addressed: boolean
  /** Which rule decided. 'unsure' means not addressed (the Mind doesn't interrupt humans). */
  by: 'single_human' | 'name' | 'reply' | 'question' | 'other_human' | 'classifier' | 'unsure' | 'default'
}

export interface AddressingDetector {
  /** Whether the Mind should take a turn for this input in a group thread. Never throws. */
  decide(a: {
    threadId: ThreadId
    input: { authorPersonId: PersonId; text: string }
    /** Visible messages before the input, oldest first (at most 10). */
    recent: MessageRecord[]
    /** Current participants' names. */
    participantNames: string[]
    signal: AbortSignal
  }): Promise<AddressingVerdict>
}

/**
 * `details.reason` of the `KeithError('FORBIDDEN')` that `GroupThreads` throws when a rule refuses
 * (ADR-0017). The `thread.*` tools turn each into a tool error.
 * - `tier`: the creator or inviter is below `member`.
 * - `not_participant`: the inviter is not a current participant of the thread.
 * - `not_group`: the thread is not a group thread (invite, or leave a direct thread).
 * - `limit`: current participants plus pending invitations would exceed `mind.group.maxParticipants`.
 * - `no_invitees`: the invitee list is empty.
 * - `self`: the invitee list names the caller.
 * - `unknown_person`: an invitee id is not a person.
 */
export type GroupRefusalReason =
  | 'tier'
  | 'not_participant'
  | 'not_group'
  | 'limit'
  | 'no_invitees'
  | 'self'
  | 'unknown_person'

/**
 * Starting, joining and leaving group threads (ADR-0017). Emits `thread.participant_joined` and
 * `thread.participant_left` after the storage write. A refusal by rule throws
 * `KeithError('FORBIDDEN')` with `details.reason: GroupRefusalReason`; an unknown thread throws
 * `KeithError('NOT_FOUND')`.
 */
export interface GroupThreads {
  start(a: {
    creatorId: PersonId
    inviteeIds: PersonId[]
    title: string
    purpose: string | null
  }): Promise<{ thread: ThreadRecord; invited: PersonId[]; joined: PersonId[] }>
  invite(a: {
    threadId: ThreadId
    inviterId: PersonId
    inviteeIds: PersonId[]
  }): Promise<{ invited: PersonId[]; joined: PersonId[]; skipped: PersonId[] }>
  /** Accepts a pending invitation. False without one. */
  join(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
  /** Leaves a group, or declines a pending invitation. False when neither applies. */
  leave(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
}
```

The ThreadManager maps `RunLoopEvent`s to `message.delta`, `tool.activity` and `ui.render` frames. The scheduler ignores most of them for tasks (it keeps `ui` for the task result).

**Group-thread factories (phase 5, [Group threads](#group-threads)).** Two factories, exported from `mind/index.ts`, with their deps fixed by P5-K1:

- `createAddressing(deps: AddressingDeps): AddressingDetector` (`mind/addressing/`). Deps: `config` (`mind`), `runLoop`, `scheduler` (`run`), `log`.
- `createGroupThreads(deps: GroupThreadsDeps): GroupThreads` (`mind/groups.ts`). Deps: `config` (`mind`), `repos` (`persons`, `threads`, `threadInvitations`), `deliveries` (`enqueue`), `events` (`emit`), `ids`, `clock`, `log`.
- `ThreadManagerDeps.addressing?: AddressingDetector`. Without it every group input is addressed (the phase-4 behavior).

> Planned (phase 5, P5-I1): bootstrap doesn't build `createAddressing` or `createGroupThreads` yet.

### Voice (`voice/types.ts`), implemented by `voice/` (P3-A1)

Phase 3 ([voice.md](voice.md), [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md)). The server calls `VoiceInput` for `audio.start` / `audio.end` and kind-1 binary frames; the Mind calls `VoiceOutput` for audio-modality turns. Both are optional deps: without `[voice]` the core behaves as in phase 2.

```ts
/** Why `VoiceInput.start` refused a stream. The server replies `error { INVALID_FRAME, message }`. */
export type VoiceStartResult = { ok: true } | { ok: false; code: 'INVALID_FRAME'; message: string }

/**
 * Audio from nodes, one stream per `audio.start` … `audio.end`. The server checks `audio.in@1`
 * and that the node has the thread open before calling `start`. No method throws.
 */
export interface VoiceInput {
  /**
   * An `audio.start` frame. Refused (not thrown) when voice is off, the codec or rate is not
   * supported (v1: `pcm16` only), or the stream id is already in use.
   */
  start(a: {
    nodeId: NodeId
    personId: PersonId
    threadId: ThreadId
    streamId: AudioStreamId
    codec: AudioCodec
    sampleRate: number
  }): VoiceStartResult
  /**
   * A kind-1 binary frame. Returns false when the node has no open stream with this id (the
   * server replies `INVALID_FRAME`). Out-of-order chunks of an open stream are dropped and
   * logged at debug, and still return true.
   */
  chunk(a: { nodeId: NodeId; streamId: AudioStreamId; sequence: number; payload: Uint8Array }): boolean
  /**
   * An `audio.end` frame: the buffered utterance, if any, goes to STT. Returns false when the node
   * has no open stream with this id.
   */
  end(a: { nodeId: NodeId; streamId: AudioStreamId }): boolean
  /** The node's socket closed: drop its open streams without running STT. */
  detach(nodeId: NodeId): void
}

/** Speaks assistant replies. The Mind calls it only for audio-modality turns (voice.md). */
export interface VoiceOutput {
  /**
   * Starts speaking `messageId` on `nodeId` (the focus node). Returns null when voice is off or
   * the node lacks `audio.out@1`; the reply is then text only.
   */
  begin(a: { threadId: ThreadId; nodeId: NodeId; messageId: MessageId }): SpeechHandle | null
}

/**
 * One spoken reply. Text is cut into sentences and spoken in order; the audio goes to the node as
 * `audio.start`, kind-2 binary frames, then `audio.end`.
 */
export interface SpeechHandle {
  /** A text delta of the assistant message, in order. Ignored after `end` or `stop`. */
  push(text: string): void
  /** No more text: speak what is buffered, then send `audio.end`. */
  end(): void
  /**
   * Barge-in or cancel: aborts TTS, sends `audio.stop` if audio was started, and returns
   * `spokenChars`, the characters of the pushed text whose audio was fully sent. Idempotent: a
   * later call returns the same number.
   */
  stop(): number
  /**
   * Settles when the last frame was sent after `end`, or right after `stop`. Never rejects: a TTS
   * error is logged and ends the speech early.
   */
  done: Promise<void>
}
```

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

/** Phase 4: reminders (docs/architecture/core.md#reminders). */
export interface ReminderService {
  /**
   * Stores a `pending` reminder. Throws a `KeithError` when the person already has
   * `mind.reminder.maxPerPerson` pending reminders, or when `text` (trimmed) is not 1..500 characters.
   */
  set(r: { personId: PersonId; threadId: ThreadId | null; text: string; dueAt: number }): Promise<Reminder>
  /** Cancels the person's own `pending` reminder. False for an unknown id, someone else's, or one not pending. */
  cancel(a: { id: ReminderId; personId: PersonId }): Promise<boolean>
  /** The person's `pending` reminders, soonest first. */
  listFor(personId: PersonId): Promise<Reminder[]>
  /** Enqueues a `reminder` delivery for every due reminder, then marks it fired. Returns how many fired. */
  fireDue(now: number): Promise<number>
}

/** Phase 5: why `RelayService.send` refused. The tool answers `not_allowed` generically (ADR-0017). */
export type RelayResult =
  | { ok: true; delivery: Delivery }
  | { ok: false; reason: 'unknown_recipient' | 'self' | 'not_allowed' }

/** Phase 5: relays between people (I-13, docs/architecture/core.md#relays). */
export interface RelayService {
  /** I-13 per ADR-0017. Enqueues a `relay` delivery authored by the sender into the recipient's main thread. */
  send(a: { fromPersonId: PersonId; toPersonId: PersonId; text: string }): Promise<RelayResult>
  /** Adds or removes `from` in `personId`'s `blockedRelayFrom`. Returns whether the list changed. */
  block(a: { personId: PersonId; from: PersonId }): Promise<boolean>
  unblock(a: { personId: PersonId; from: PersonId }): Promise<boolean>
}
```

`createScheduling` builds the relay service with `createRelayService(deps: RelayServiceDeps)` (`scheduler/relay.ts`; deps `repos` (`persons`, `relationships`, `threads`), `deliveries` (`enqueue`), `log`) and exposes it as `Scheduling.relay`. See [Relays](#relays).

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

// Phase 4: reflection and thread summaries (ADR-0014)

/** What one reflection pass over a thread did. */
export type ReflectionResult = {
  threadId: ThreadId
  /** The new reflection cursor: the last message `seq` the pass read. */
  throughSeq: number
  /** Memories written (new, `source: 'inferred'`). */
  written: MemoryId[]
  /** Existing memories whose content was rewritten. */
  merged: MemoryId[]
  /** Persons whose relationship notes were rewritten. */
  cardsUpdated: PersonId[]
}

export interface Reflector {
  /**
   * One pass over the thread's messages after its reflection cursor. Returns null when there is
   * nothing new. Moves the cursor and emits `memory.reflected` on success.
   */
  reflect(a: { threadId: ThreadId; signal: AbortSignal }): Promise<ReflectionResult | null>
}

export interface ThreadSummarizer {
  /**
   * Folds the rows that left the recent-messages window into `threads.summary`. Returns false
   * (and calls no model) when fewer than `memory.summary.minMessages` rows are pending. Emits
   * `thread.summarized` when the summary changed.
   */
  update(a: { threadId: ThreadId; signal: AbortSignal }): Promise<boolean>
}

/** A background job with a lifecycle, started and stopped by bootstrap. */
export interface MemoryJob {
  /** Subscribes to its trigger event. Idempotent. */
  start(): void
  /** Unsubscribes, aborts running passes and resolves once they have settled. */
  stop(): Promise<void>
}
```

The digest builds its activity picture from events (`thread.state_changed`, `task.*`) plus repositories. It never calls the mind, so there is no cycle.

**Memory jobs (phase 4, [ADR-0014](../decisions/0014-reflection-writes-conservative-inferred-memories.md)).** Two factories, exported from `memory/index.ts`, each return the worker and a `MemoryJob` that bootstrap starts and stops:

- `createReflection(deps): { reflector: Reflector; job: MemoryJob }` (`memory/reflect/`). Deps: `config` (`memory`, `mind`), `repos` (`threads`, `messages`, `memories`, `relationships`, `persons`), `memory` (the `MemoryService`), `runLoop`, `scheduler` (`run`), `events`, `clock`, `ids`, `log`. The job reacts to `scheduler.ticked`.
- `createThreadSummaries(deps): { summarizer: ThreadSummarizer; job: MemoryJob }` (`memory/summary/`). Same deps without `memory`, and `repos` is `threads`, `messages` and `persons` (speaker names in the transcript). The job reacts to `turn.completed`: each event schedules one update of its thread, and events for a thread whose update is queued or running are coalesced into at most one follow-up.

Both call the `utility` model through `RunLoop` (no tools, one step, `persist: null`) and run in the `background` lane. See [memory.md](memory.md#reflection).

Bootstrap builds both in step 7 with the real `RunLoop`, `scheduling.scheduler`, repositories and `MemoryStore`, and starts both jobs in step 12 (below).

### Construction order (bootstrap)

The only order that has no cycles. `bootstrap.ts` follows it:

0. the `KEITH_HOME` lock (`acquireHomeLock`, [config.md](config.md#logs-and-lock)). A second Keith on the same home fails here, before anything is opened (I-1).
1. config → logger (stdout plus `logs/keith.log`), clock, ids; the home folders are created
2. db + repositories → event bus
3. registries: services, tools, skills (with a logger, so a plugin replacing a default skill is logged), agents, providers, plugin data stores (standalone objects from `plugins/`)
4. `AttachmentRegistry` + `Presence` (from `server/`)
   - **4b.** voice pipeline (phase 3), only with a `[voice]` section ([voice.md](voice.md)). It needs the `ThreadManager` and the `ThreadManager` needs its output, so it reaches the `ThreadManager` through a late binding. It also tracks each node's `hello` capabilities from `node.connected`.
5. `RunLoop` (from `mind/`, needs providers, tools, repositories)
6. scheduler, tasks, commitments, deliveries, reminders and the relay service (needs `RunLoop`)
7. memory (needs repositories, events, config), then the phase-4 memory jobs: `createReflection` and `createThreadSummaries` (need memory, `RunLoop`, `scheduling.scheduler`, repositories, events, config). Built, not started.
8. `ThreadManager` (needs everything above, and the voice output). It subscribes to `delivery.enqueued`, so nothing calls into it from below. Arrival reaches it only through `open({ arrival })`, never through the `person.arrived` event (which is for plugins).
9. server (needs `ThreadManager`, attachments, presence, the voice input) builds its http and ws registries, **without listening yet**. It reads the plugin host's `status()` for the notices after `welcome` through a late binding (the host is built in step 11).
10. built-in tools registered through the privileged `tools.registerBuiltin()`, including the `reminder.*` tools (`reminders: { service: scheduling.reminders, config, clock }`), and the default skill `morning_briefing`
11. plugin host (needs registries, server http/ws, the delivery sink, the data stores) → load → `setup` → `start`, then `checkVoiceProviders`: every `voice.vad/stt/tts` id must name a registered provider (`CONFIG_INVALID` otherwise)
12. `scheduling.start()` (recovers tasks, starts the tick, subscribes `fireDue`), then the reflection and summary jobs `start()`, server `listen()` → emit `core.started`

> Planned (phase 5, P5-I1): step 8 also builds `createAddressing(...)` and `createGroupThreads(...)` and passes `addressing` to the ThreadManager; step 10 passes `relay: { service: scheduling.relay, persons }` and `groups: { service: groups, persons, threads, config }` to `registerBuiltins`, which registers the `relay.*` and `thread.*` tools only when they are given.

Shutdown runs the other way: presence flush, server stop, `threads.stop()` then `threads.cancelAll()` (each running turn persists its partial reply), presence, the reflection and summary jobs (unsubscribed, running passes aborted; an aborted pass writes nothing), scheduling, memory, plugins, event bus, database, log file, and the home lock last. A start that fails tears down what it built, lock included; the memory jobs stop before scheduling there too.

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
- **Input while `thinking` or `speaking`.** Text input is queued and becomes the next turn. Nothing is lost, and the model sees both messages. Spoken input can also barge in (below).
- **`input.cancel`** aborts the running turn's `AbortSignal`. The partial assistant text is persisted with `meta.cancelled = true`.
- **Focus** is set to the node of each new input, and by `open` when the thread has no focus yet. Audio output goes to the focus node only. Text and UI go to every node attached to the Thread (I-7).
- Each new user input is echoed to the *other* attached nodes as `message.user`. Two inputs are also echoed to the sending node: a `ui.action` click and a spoken input (its transcript comes from the core's STT, so the speaking node has no other copy).
- **Queue details.** One turn runs per thread at a time. Inputs that arrive while a turn runs wait in a FIFO; when the turn ends, *all* waiting inputs become the next turn together. A queued input is echoed right away but persisted when its turn starts, so history reads `user → reply → next user` rather than two user messages before the reply. In a group thread, inputs first pass addressing, and inputs nobody addressed to the Mind are stored without a turn ([Group threads](#group-threads)).
- **Focus fallback.** When the focus node detaches, focus is empty until the next input; a turn without focus uses the capabilities of the most recently attached node.
- **History on open.** `open` returns the latest `historyLimit` visible messages (default 50, at most 200, 0 = none), oldest first. Hidden rows (tool rows and tool-step assistant rows) don't count toward the limit.
- **Cancel all (shutdown).** `MindThreadManager.cancelAll()` aborts every running turn and resolves once each has persisted its cancelled reply; no new turn starts while it runs. After `stop()` no new turn starts at all.
- **Listening (phase 3).** `voiceActivity({ speaking: true })` moves an `idle` thread to `listening`. The input that follows (from the voice pipeline) starts the turn as usual (`thinking`). `speaking: false` without an input, or the speaking node detaching, returns `listening` to `idle`. Speech on any node while a turn runs doesn't change the state unless it is a barge-in.
- **Spoken replies (phase 3).** When the turn's latest input has `modality: 'audio'`, the Mind has a `VoiceOutput` (`ThreadManagerDeps.voice`) and the focus node declared `audio.out@1`, the Mind calls `VoiceOutput.begin` for the focus node and pushes every text delta to the `SpeechHandle`. Text still goes to every attached node (I-7). The reply is stored with `modality: 'audio'`. The turn stays `speaking` until the handle's `done` settles, and `message.completed` is sent after that, so a barge-in during playback can still cut the stored text. Without `voice` deps the Mind behaves exactly as in phase 2.
- **Barge-in (phase 3).** `voiceActivity({ speaking: true })` from the focus node while `thinking` or `speaking` stops the speech right away (`SpeechHandle.stop()`, which sends `audio.stop`) and cancels the turn as `input.cancel` does. A cancelled spoken reply (barge-in or `input.cancel`) is stored with `content` cut to the `spokenChars` that `stop()` returned and `meta: { cancelled: true, spokenChars }`, the same in `message.completed` and history. After a barge-in the thread goes to `listening`. The Mind applies `voice.bargeIn` (false: speech never cuts a reply) and `voice.bargeInMinMs`: the barge-in happens only if no `speaking: false` from that node arrives within that time. Without a `[voice]` section, barge-in is on with no minimum. The voice pipeline reports raw VAD start and stop and does not apply the minimum itself.

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
- **Tool events.** `tools.invoke` is the one place that emits `tool.called` and `tool.completed`: exactly one pair per invocation, including unknown tools, invalid arguments, tier refusals and calls already aborted (`ok: false`). The run loop emits no tool bus events; it only reports `tool.started` / `tool.completed` to its caller through `onEvent`.
- **Tool errors** never crash a turn. The error text becomes the tool result so the model can recover. Unknown tools, invalid arguments and tier refusals are handled the same way.
- **Tool tier check:** `tools.invoke` enforces `tool.minTier` against the **lowest tier among `runCtx.participants`** (for tasks, the task's person).
- **Provider errors:** retryable ones (network, 429, 5xx) are retried by the loop up to 2 times with backoff, then surface as an `error` frame plus a short assistant apology message. A turn that fails because the provider answered `rate_limited` (after the retries) raises `KeithError('RATE_LIMITED')` and its `error` frame and `turn.failed` carry `RATE_LIMITED`; every other provider failure (including a stall) is `PROVIDER_ERROR`.
- **Tool call ids:** the provider's `LlmToolCall.id` is persisted as-is. See [storage.md](storage.md#messages-and-tool-calls).
- A tool result's `ui` block is persisted on the assistant message and sent as a `ui.render` frame to attached nodes that declared `ui.render@1`. The model only ever sees `content` (text).
- **Messages of a turn.** Nodes see one assistant message per turn (the `messageId` of `message.started`); its content is all text streamed in the turn and it carries the turn's `ui` entries. When `persist` is set, the loop also stores each tool step as an assistant row with `toolCalls` plus one `tool` row per call. Those rows are replayed to the model but hidden from nodes (history and `thread.opened` skip them). History is ordered by the per-thread `seq` that storage assigns on insert ([storage.md](storage.md)), so it is the order rows are stored in: a queued input is stored when its turn starts, the turn's tool-step rows as they happen, and the turn's message last, even though its id was taken when the turn started.
- **Retry and stall details.** A retryable provider error is retried only before the step's first text or tool event (otherwise the node would see text twice). A stalled step is not retried: it fails the turn with `PROVIDER_ERROR`. A failed turn keeps any partial text and appends the apology.
- **Replay window.** The recent-messages window may cut a tool step in half. Orphan `tool` rows are dropped, and an assistant row whose calls lack results is replayed as plain text.

## Context builder

Builds `{ system, messages, tools }` for a Viewer. The system prompt is assembled in this order. Each section is a separate, testable function:

1. **Persona:** `~/.keith/persona.md` (see [config.md](config.md)).
2. **Now:** current date/time and timezone, plus the focus node's capabilities (so the model knows whether it can show UI or is being heard).
3. **Participants:** each participant's relationship card (name, tier, tone, notes). In a group thread (phase 5) the section also has the thread's title and `purpose`, every current participant's card (`viewer.participants`), one line naming whose message the turn answers (the author of the latest user message, in `user` turns only), the tone rule from S-6 ("Several people read this thread. Use the most formal tone among the participants unless you are answering one person directly.") and "People talk to each other here too. Answer only what is addressed to you, and keep it short." A direct thread's section is unchanged.
4. **Core memories:** `MemoryService.core(viewer)`.
5. **Memory index:** `MemoryService.index(viewer)`, so the model knows recall is worth trying.
6. **Awareness digest:** `MemoryService.digest(...)`, 5 lines at most.
7. **Open commitments** in this Thread.
   - **Thread summary (phase 4):** `# Earlier in this thread` with `threads.summary` ([memory.md](memory.md#thread-summary)). Left out when the thread has no summary.
8. **Pending deliveries:** only in delivery turns and arrival turns, with instructions to phrase them naturally. When a skill named `morning_briefing` is registered, the briefing and arrival instructions add "If the skills index lists `morning_briefing`, load it first." (the builder passes the registered skill names to the section). Phase 5: a `relay` item reads "(relay from <sender name>)" and adds an instruction to pass it on here, saying who it is from; an `invitation` item reads "(invitation from <inviter name>)" before its content (which holds the thread id) and adds an instruction to ask whether they want to join, call `thread.join` with the id when they agree and `thread.leave` with it when they decline. The builder reads those authors' names with `persons.get`; an author who no longer exists reads as "Someone".
9. **Skills index:** name + one-line description of every registered skill (full text loads through `skill.load`).

**Messages:** without a summary cursor (`threads.summary_through_seq` is null), the last `mind.context.recentMessages` stored rows (default 40). The window counts every row, including the tool-step assistant rows and `tool` rows that nodes don't see, so a turn with many tool steps leaves fewer visible messages in it.

**Window rule with a summary.** The messages are the rows with `seq > summaryThroughSeq`, but at least `recentMessages` and at most `recentMessages + memory.summary.minMessages` (the latest ones in both cases). The summary job folds rows once `minMessages` of them have left the `recentMessages` window, so while it keeps up no row falls between the summary and the window. Fewer rows after the cursor than `recentMessages` (the setting grew) means some overlap with the summary; more than the upper bound (the job fell behind or is off) means a gap until it catches up. The replay rules for orphan tool rows apply to this window as well.

**Author names (phase 5, D7).** In a group thread (`threads.kind = 'group'`), `toLlmMessages(records, { group: true, names })` gives each `user` message `LlmMessage.name` = its author's name **and** a `<name>: ` content prefix, because not every provider honours `name`. Names come from the participants' cards, plus `persons.get` for authors who left the group. An author who no longer exists (their group messages are deleted with them, ADR-0018) or a null author reads as "Someone". Assistant and tool messages carry no name. Direct threads replay exactly as before.

**Tools:** every tool in the registry, built-ins included, where `tool.minTier` is at or below the lowest participant tier (owner > member > guest) and `tool.requires ⊆` the focus node's capabilities.

## Scheduler

Three lanes, each with its own concurrency limit. Separate pools make I-5 structural rather than a matter of priority tuning. A **job** is any unit of work the scheduler runs: a turn or a task step.

| Lane | Used by | Default concurrency (config key) |
|---|---|---|
| `foreground` | User turns | 4 (`scheduler.foreground`) |
| `delivery` | Delivery and briefing turns | 2 (`scheduler.delivery`) |
| `background` | Tasks, reflection and thread summaries (phase 4) | 2 (`scheduler.background`) |

A **tick** fires every `scheduler.tickMs` (default 30 000) and emits `scheduler.ticked`. Plugins, commitment expiry, due reminders (`ReminderService.fireDue`, subscribed by `scheduling.start()`) and reflection (phase 4) use it. Jobs in one lane never wait on another lane's pool. Within a lane, waiting jobs start in FIFO order. A job whose `signal` aborts while it waits leaves the queue, and `run` rejects with the signal's reason.

## Tasks

A Task is background work run with an Agent.

- Started by the built-in tool `task.start({ agent?, goal, notify, promise? })`. `notify` is `'when-done'` (creates a Commitment) or `'silent'`. `agent` defaults to the built-in `general`, whose tools are every non-reserved registry tool plus `memory.recall`, `memory.remember` and `skill.load`. Plugins add agents through the agent registry.
- **Task context:** the Agent's system prompt + a short persona line + the goal + the relationship cards of everyone the task runs for. Tasks don't get thread history. They use `memory.recall` when they need more. The task runs `RunLoop` with the Agent's tools, the `background` model role, `persist: null`, `runCtx.personId` = the task's person and `runCtx.participants` = everyone it runs for.
- **Who a task runs for.** A task started in a direct thread (or without a thread) runs for its person. A task started in a group thread runs for the group's current participants at the moment it starts running (read again on a restart; a group nobody is in any more falls back to the task's person). So in a group its tools are filtered by the lowest tier among them (a guest in the group limits the task too), its memory reads admit only what every one of them may see (I-4), the persona line names the group and its participants, and the context holds all of their cards.
- **Visibility:** `subject` when started in a direct thread, `thread` when started in a group thread. A group task's commitment is in the group thread, so its `task_result` / `task_failed` delivery goes to the group (its `personId` is the person who started it).
- **v1 limits:** tasks cannot start tasks, at most `mind.task.maxPerPerson` (default 3) active (`queued` or `running`) per Person, and a timeout of `mind.task.timeoutMs` (default 1 800 000), counted from the moment the task starts running. Over the limit, `task.start` returns a tool error (`TASK_LIMIT_REACHED`) the model can read. A timeout fails the task.
- **Status:** `queued → running → completed | failed | cancelled`. On core start, tasks left `queued` are scheduled again, and tasks left `running` are re-queued once (`attempt` 2). A second interruption fails them. A graceful shutdown aborts running tasks without changing their stored status, so the next start recovers them. A run that ends with empty text counts as failed.
- The result is stored on the task as `summary` (the result text cut to 500 characters, for contexts and deliveries) plus `detail` (full text) plus optional `ui` (the last `ui` block the run produced).
- `task.status` shows one task (with its result) or lists the active tasks the conversation may see. `task.status` and `task.cancel` see exactly the tasks the visibility rule admits for the call's viewer (every participant of the context, I-4; `TaskManager.visibleTo`, checked with `isVisible` on the task's visibility, its person as the subject and its thread): in a direct thread, the person's own tasks and the tasks of the groups they are currently in; in a group, only that group's tasks (and those of other groups everyone in it shares), never a participant's private task. Anyone who sees a task may cancel it. A task the viewer may not see reads as not found. The three `task.*` tools require tier `member`. In phase 1, results are *not* written as memories. They reach later contexts through the delivery message in thread history and through `task.status`. Phase 4 reflection distills them.
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
| `reminder` | `reminder.set` built-in, fired on a tick ([Reminders](#reminders)) | 4 |
| `relay` | `relay.send` built-in (I-13) | 5 |
| `invitation` | `thread.start_group` | 5 |

**Enqueueing.** `DeliveryQueue.enqueue` persists the item and emits `delivery.enqueued`; it never calls the Mind. Without a `threadId` it targets the person's `main` thread and fails with `NOT_FOUND` if that thread doesn't exist yet. A task's delivery goes to its commitment's thread; `silent` tasks have no commitment and deliver nothing. The plugin sink (`ctx.deliveries`) validates the input with zod, refuses (`FORBIDDEN`) a `threadId` the person doesn't participate in, and records `source` = the plugin id.

**Flush triggers.** The ThreadManager checks the queue when (a) a `delivery.enqueued` event arrives for a thread, (b) a turn ends, (c) an arrival's hold ends (below), (d) `open` is called and no hold starts (a reconnect below the threshold, or `briefing = off`), and (e) `listening` ends without an input (phase 3). It flushes only when the thread is `idle`, the person is present, and no arrival hold is active. While the thread is `listening` (someone is speaking to it) no delivery or briefing turn starts; a due briefing waits the same way.

**Delivery turn.** Runs in the `delivery` lane with the `foreground` model role (like user turns and briefing turns; only tasks use `background`). All pending items go into context at once (section 8), ordered by urgency. Frames are `proactive: true`. After the assistant message is persisted, every item that was in context is marked delivered (with that `messageId`, stored as the delivery's `message_id`), whether or not the model mentioned it. Items that carry `ui` (plugin deliveries, task results) bring their blocks along, exactly like tool UI: when the turn completes, each block is validated, sent as `ui.render` (with `uiBlockToText` as `fallbackText`) to the thread's `ui.render@1` nodes before `message.completed`, and stored as a `ui` entry of that message (`toolCallId` `delivery:<deliveryId>`, `toolName` `delivery:<source>`), so it is in `message.completed` and history. A block reusing a block id already on the message is dropped with a warning. A failed or cancelled turn attaches no block (its items stay pending). The same applies to a user turn that carries the pending items after an arrival. `critical` items flush before any queued user input. If such a pre-empting delivery turn fails or is cancelled, the queued input runs next instead of another delivery turn.

**Away.** Deliveries wait until the person is present again.

**Flush details.** Trigger (d) runs on the next macrotask after `open` returns, so the server sends `thread.opened` before any turn frame. Items in a delivery turn are marked delivered only if the turn completed; after a failed or cancelled turn the flush waits for the next trigger (no retry loop).

### Reminders

A Reminder (`rem_` id, table `reminders`) is a text the Mind brings up for one person at a due time. `ReminderService` (`scheduler/reminders.ts`, exposed as `Scheduling.reminders`) stores it; the `reminder.*` built-ins call it.

- **Set.** `reminder.set { text (1..500), at? | inMinutes? }`: exactly one of `at` (ISO 8601; without an offset it is a wall-clock time in `mind.timezone`, converted with `Intl`) or `inMinutes`. A wall-clock time that doesn't exist or exists twice (a DST change) resolves to the later instant. A date that doesn't exist, a due time in the past, or one more than 366 days ahead is a tool error. At most `mind.reminder.maxPerPerson` (default 50) pending reminders per person: `ReminderService.set` throws `FORBIDDEN` (details `{ limit }`) at the limit, and the tool answers with a tool error. The reminder targets the current thread, or the person's `main` thread inside a task (`threadId` null). The answer is `Reminder <id> set for <weekday, date, time> (<timezone>): <text>`.
- **Fire.** `scheduling.start()` subscribes `fireDue` to `scheduler.ticked` (with the tick's `at` as "now"), so a reminder fires within one tick (`scheduler.tickMs`, default 30 s) of its due time. `fireDue` calls are serialized, so overlapping ticks never fire a reminder twice. For every due `pending` reminder, soonest first, `fireDue` enqueues a `reminder` Delivery (`urgency: 'high'`, `source: 'core'`, content = the text), then marks the reminder `fired` with that delivery's id. The delivery surfaces like any other (I-11); while the person is away it waits for them.
- **At least once.** A crash between the enqueue and the mark can deliver one reminder twice after a restart; none is lost. If the enqueue fails (for example `NOT_FOUND`: no `main` thread yet), the failure is logged, the reminder stays pending and fires on a later tick, and the other due reminders still fire. A reminder due while the core was down fires on the first tick after start.
- `reminder.list` shows the caller's pending reminders, one `id: when (timezone) — text` per line. `reminder.cancel { id }` cancels only the caller's own pending reminder; any other id reads as "No such reminder."
- There are no `reminder.*` events: a fired reminder is a `delivery.enqueued` with `kind: 'reminder'`.

The tools are registered only when `registerBuiltins` gets `reminders` (`{ service, config, clock }`).

### Relays

Rules: [ADR-0017](../decisions/0017-tier-rules-for-relays-and-group-threads.md).

A relay passes one person's words to another through Keith (I-13, S-5). `RelayService` (`scheduler/relay.ts`, exposed as `Scheduling.relay`) decides and enqueues; the `relay.*` built-ins call it.

- **Checks** (`RelayService.send`, in order): the sender and the recipient are the same person → `self`; the recipient doesn't exist or has no `main` thread → `unknown_recipient`; the sender is a guest and the recipient is not the owner, or the recipient's `relationships.blockedRelayFrom` names the sender → `not_allowed`. A block wins over every tier, the owner's included. A sender that doesn't exist is refused as `not_allowed` too (logged as a warning). The log records who relayed to whom and which rule refused, never the text.
- **Delivery.** Otherwise it enqueues `{ personId: to, threadId: <their main>, kind: 'relay', authorPersonId: from, source: 'core', urgency: 'normal', content: <the text, verbatim> }`. The relay flushes like any delivery (I-11): now if the recipient is present and the thread idle, else on their next arrival. v1 relays go only to the recipient's main thread, never into a group.
- **Attribution.** Section 8 labels the item with the sender's name (P5-C3). The delivery turn's assistant message stores `meta.relayFrom` (`{ personId, name }` per sender, in delivery order), so `message.completed` and history carry it and a node can show "via Tony" even if the model paraphrases. The same holds for a user turn that carries relays after an arrival. Several relays from one sender give one entry; a sender who no longer exists gives none.
- **Answers** (`RELAY_MESSAGES`): "I'll pass that on to <name>.", "I don't know anyone called <name>.", and one generic refusal for a tier rule and a block alike: "I can't pass messages from you to <name>." Relaying to yourself answers "You can't relay to yourself."
- **Blocks.** `relay.block { from }` / `relay.unblock { from }` change only the caller's own `blockedRelayFrom` (`RelayService.block` / `unblock`). The service reads the card (a missing card counts as empty, with `tone` and `notes` `''`), adds or removes the id, and upserts only when the list changed, keeping `tone` and `notes`; it answers whether it changed. `personId === from` changes nothing. The tools answer with `RELAY_MESSAGES`: blocked / already blocked, unblocked / not blocked, the unknown-name text, and "You can't block yourself." (unblocking yourself answers "not blocked"). The owner can change anyone's list with `keith person block` / `unblock`.
- A relay writes no memory. It reaches later contexts only through the recipient's thread history. There are no `relay.*` events: a relay is a `delivery.enqueued` with `kind: 'relay'`.

The tools are registered only when `registerBuiltins` gets `relay` (`{ service, persons }`); names resolve through `persons.findByName` (a name or username, case-insensitive).

## Presence and arrival

- A Person is **present** while at least one attended node has one of their Threads open. `persons.last_seen_at` is written when they become away, refreshed on every scheduler tick while they are present, and written for every present person on graceful shutdown. Arrival detection survives restarts and crashes, and a crash costs at most one tick of accuracy.
- The server decides arrival when a person's first node attaches: `awayMs = now − last_seen_at`. It is an arrival if `awayMs ≥ mind.arrival.awayAfterMinutes × 60 000` (fractional minutes allowed), or if `last_seen_at` is null (first-ever attach, `awayMs: null`, a first meeting). The server then passes `arrival` to `ThreadManager.open` and emits `person.arrived`. Plugins may enqueue Deliveries in response (news, weather).
- `mind.arrival.briefing` controls what happens on arrival:
  - `on-greeting` (default): an **arrival hold** starts, and no delivery turn runs. The first user turn after arrival gets all pending deliveries in context (section 8). If the input is a greeting or a catch-up question, the model leads with them. Otherwise it answers first and then mentions them briefly. After that turn's reply is persisted, the included items are marked delivered. If no input arrives within `mind.arrival.holdMs` (default 120 000), the hold ends and a normal delivery turn runs.
  - `auto`: after a grace period of `mind.arrival.graceMs` (default 1 500, so plugin deliveries can land), a briefing turn runs in the delivery lane. It is a delivery turn whose instructions also say to greet. It always runs, also when nothing is pending (then it only greets) and on a first meeting (`awayMs: null`).
  - `off`: no hold, normal flush.
- The `auto` grace period works like a short hold: deliveries that land during it wait for the briefing. Input during an `on-greeting` hold or an `auto` grace ends it, and that user turn carries the pending deliveries (the briefing turn is skipped).

## Built-in tools

Registered with `tools.registerBuiltin()`. Their namespaces are reserved. `registerBuiltins` also registers the core's **default skills** with `skills.registerDefault()` (phase 4: `morning_briefing`, `builtins/skills/`). A plugin skill with the same name replaces a default ([plugin-api.md](../contracts/plugin-api.md#skills)).

| Tool | Phase | Purpose |
|---|---|---|
| `task.start`, `task.status`, `task.cancel` | 1 | Background work |
| `skill.load` | 1 | Load a skill's full instructions |
| `memory.remember`, `memory.recall`, `memory.forget` | 1 (FTS), 4 (reflection) | Write, search and delete memories |
| `reminder.set`, `reminder.list`, `reminder.cancel` | 4 | Time-based deliveries ([Reminders](#reminders)); tier `member` |
| `relay.send`, `relay.block`, `relay.unblock` | 5 | Pass messages between people, and refuse them ([Relays](#relays)); tier `guest` |
| `thread.start_group`, `thread.invite` | 5 | Start a group thread, invite more people ([Group threads](#group-threads)); tier `member` |
| `thread.join`, `thread.leave` | 5 | Accept an invitation; leave a group or decline an invitation; tier `guest` |

The tiers come from [ADR-0017](../decisions/0017-tier-rules-for-relays-and-group-threads.md). `builtins/relay.ts` and `builtins/thread.ts` also export the input schemas, the tool names and the answers (`RELAY_MESSAGES`, `THREAD_MESSAGES`).

> Planned (phase 5, P5-I1): bootstrap doesn't pass `relay` or `groups` to `registerBuiltins` yet, so none of the seven is registered.

## Group threads

Rules: [ADR-0017](../decisions/0017-tier-rules-for-relays-and-group-threads.md). Scenario: [S-6](../concept/scenarios.md#s-6-collaboration-a-group-thread-with-shared-state). Bootstrap wiring is P5-I1.

A group thread (`kind: 'group'`, `slug` null) has several human participants (`thread_participants`), a `title` and an optional `purpose`. Participants and message authors are stored from phase 1.

**Membership** (`GroupThreads`, `mind/groups.ts`):

- `start` (`thread.start_group`): the creator must be `member` or higher (`tier`). The invitee list must be non-empty (`no_invitees`), must not name the creator (`self`), must name only known persons (`unknown_person`) and at most `maxParticipants − 1` of them (`limit`); duplicates count once. It creates the group (`slug` null, `ownerPersonId` = creator, `title`, `purpose`) with the creator as its only participant (`thread.participant_joined { invitedBy: null }`), then invites the others as `invite` does.
- `invite` (`thread.invite`): only in a group (`not_group`), only by a current participant (`not_participant`) with tier `member` or higher (`tier`), only while current participants plus pending invitations plus the new invitees stay within `mind.group.maxParticipants` (default 8, `limit`). The creator has no special rights after creation. People already in the group or invited are `skipped`. Each new invitee gets an `invitation` delivery in their main thread (authored by the inviter, `urgency: 'normal'`), then a `pending` `thread_invitations` row that stores the delivery id.
  - The content names the inviter, the title, the purpose and the thread id, and says how to answer: `Tony invites you to the group thread "Mission" (thr_…): <purpose>. Say whether you want to join.`
  - Its `ui` is a `card` (`id: group_invitation`) with the same text and an `actions` block with **Join** and **Decline**. A click becomes `(clicked: Join)` input ([ui.md](ui.md#interactivity)), and the invitee's model calls `thread.join` (or `thread.leave` to decline) with the id from the content.
  - With `mind.group.autoJoin = true`, an invitee with tier `member` or higher joins at once (`joined`): the delivery says `Tony added you to the group thread "Mission" (thr_…)…` and its card has no buttons, the row is stored `accepted`, and `thread.participant_joined { invitedBy }` is emitted. Guests always accept.
  - A former participant keeps an `accepted` row, which `threadInvitations.create` doesn't replace, so inviting them again answers `skipped` (known limitation until the storage contract allows it).
- `join` (`thread.join`): needs a `pending` invitation, else false. It becomes `accepted`, the person a participant (`threads.addParticipant`), and `thread.participant_joined { invitedBy }` is emitted.
- `leave` (`thread.leave`): a current participant leaves (`left_at` set, `thread.participant_left`). On a pending invitation it declines it (no event). Otherwise false. Leaving a direct thread is refused (`not_group`). Nobody can remove another participant in v1.
- Every event is emitted after the storage write. An unknown thread throws `KeithError('NOT_FOUND')`. A refusal by rule throws `KeithError('FORBIDDEN')` with `details.reason` (`GroupRefusalReason`).
- **Tools** (`builtins/thread.ts`, `ThreadToolsDeps`: `service`, `persons` (`findByName`), `threads` (`get`, `participants`), `config`): names resolve with `persons.findByName` (name, then username, case-insensitive); an unknown name answers `THREAD_MESSAGES.unknown`. `thread.invite` works in the current thread, `thread.leave` defaults to it. `thread.start_group` answers the new thread's id and title and who was invited or added; `thread.join` answers the title, so the model can tell the person where to find it; `thread.leave` answers "Left …" or "Declined …". Refusals and unknown threads come back as tool errors with the `THREAD_MESSAGES` wording, never as thrown errors.
- **After leaving**, the leaver has no access to the group: it leaves their thread list (`thread.removed`), and `thread.open` and history answer as for any thread they are not part of. The group keeps its whole history.

**Turns** (thread manager, `mind/thread-manager.ts`):

- **Live participants.** The thread manager caches each loaded thread's current participants and follows `thread.participant_joined` / `thread.participant_left` (a thread not loaded yet reads storage when it loads). A leaver can't send input or open the thread (`FORBIDDEN`, as for any non-participant), and their inputs already queued stay queued: they were said.
- **Echo.** A group input is echoed at once to the other attached nodes (`message.user`, as in direct threads).
- **Addressing.** When the thread is idle and nothing is queued, the input is decided by `AddressingDetector.decide` (the input, up to 10 visible messages before it, the current participants' names). Not addressed: the message is stored at once, with no turn, no `thread.state` change and no LLM call. Addressed: the turn runs as in a direct thread. Inputs that arrive during a turn queue as usual; when it ends they are decided in order, and the first addressed one settles it: they all become the next turn. If none is addressed, they are stored without a turn. History order stays `user → reply → next user`.
- **Deciding.** `input()` never waits for a decision. Decisions run in the thread's pump, one input after another, so an input that arrives while an earlier one is being decided waits behind it; the detector sees the earlier inputs of the same batch as recent history. `cancelAll` and `stop` abort a decision in progress. Each verdict is logged at `debug` with its `by`, never the text. A detector that throws (the contract says it doesn't) counts as not addressed.
- With fewer than two current participants every input is addressed (`single_human`, the detector isn't called). Without `ThreadManagerDeps.addressing` every input is addressed (phase-4 behavior). Direct threads never ask the detector.
- **Turn actor.** A group turn's `runCtx.personId` is the author of its latest input, and `participants` are the current participants (tools filter by the lowest tier, memory reads admit only what every participant may see, I-4). Delivery and briefing turns act as the thread's owner while they are a participant, else as the first current participant.
- **Deliveries** (for example the result of a task started in the group) flush as in direct threads: idle, some participant present, no hold. An arrival hold, and the `auto` briefing, apply only to direct threads.
- **`thread.opened`** for a group carries `purpose` (when set) and `formerParticipants` (people who left, most recent first; empty when nobody left).

**Addressing** (`AddressingDetector`, `mind/addressing/`, P5-D1). `decide` never throws. A rule pass (`rules.ts`, pure and synchronous, because it runs on every group input) goes in this order:

1. Fewer than two human participants: `single_human`, addressed.
2. `mind.name` as a whole word, in any letter case ("hey Keith", "@keith", "Keith's"; not "Keithley"): `name`, addressed. Otherwise, an input that opens by naming another participant ("Pepper, …", "@pepper …", "hey Pepper …", "Rhodey?") is `other_human`, not addressed. A multi-word name also matches by its first word.
3. The latest visible message before the input (tool messages and empty tool-calling steps are skipped) is the Mind's and ends with a question: `reply`, addressed. There is no reply-to in the protocol (D6). The detector gets no join times, so anyone who is a participant now counts.
4. A question ("?", a wh-word opening, or an auxiliary followed by a subject: "can you", "is it", "do we") that names no participant, while one of the last three visible messages is the Mind's: `question`, addressed.
5. Anything else is `unsure`, which means not addressed: the Mind doesn't interrupt humans.

With `mind.group.addressing = "rules+utility"`, an `unsure` input goes to the classifier (`classifier.ts`): one `RunLoop` run with `modelRole: 'utility'`, no tools, one step and `persist: null`, through `scheduler.run('foreground', …)` because a human is waiting (I-5). `runCtx` is the thread, with the input's author as `personId` and the author plus the humans who wrote the recent messages as `participants` (the detector gets names, not ids, for the others). The system prompt is `ADDRESSING_SYSTEM_PROMPT` (`prompts.ts`). The one user message holds only the Mind's name, the participants' names, the last 10 visible messages (each cut to 500 characters, human authors labelled "Person A", "Person B", …) and the input: no memories and no cards. The reply must be JSON `{ "addressed": boolean, "confidence": 0..1 }` (zod-checked, a code fence is tolerated). Confidence ≥ 0.7 gives `by: 'classifier'` with the model's answer; lower confidence, a 5 s timeout, an invalid reply, a provider error or an abort give `unsure`, logged at warn with the thread id and the reason, never the text. With `"rules"`, no model is called.

The labelled corpus in `mind/addressing/corpus.ts` (over 40 Tony / Pepper / Rhodey lines) is the rule pass's regression test.

**Frames.** Membership changes reach nodes as `thread.updated` / `thread.removed` ([protocol.md](../contracts/protocol.md#delivery-rules)); the server sends them on the participant events (P5-N1).
