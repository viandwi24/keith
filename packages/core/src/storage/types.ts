// Repository interfaces: the only way other folders touch the database (R-4). Tables:
// docs/architecture/storage.md. Implemented by storage/ (task P1-B1). Every method is async so
// callers don't depend on the driver being synchronous. Timestamps are integer ms (UTC).

import type { LlmToolCall } from '@keith/sdk'
import type {
  Commitment,
  CommitmentId,
  CommitmentStatus,
  Delivery,
  DeliveryId,
  FileId,
  Memory,
  MemoryId,
  MessageId,
  Modality,
  NodeId,
  PersonId,
  Task,
  TaskId,
  TaskStatus,
  ThreadId,
  Tier,
  UiBlock,
} from '../shared/types.ts'

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

export type MessageMeta = {
  cancelled?: boolean | undefined
  proactive?: boolean | undefined
  /** Phase 3: a spoken reply cut by barge-in; `content` holds only this many characters. */
  spokenChars?: number | undefined
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
}

/** An open database. Used only by bootstrap (and test helpers); everything else gets `Repositories`. */
export interface Db {
  readonly path: string
  readonly repos: Repositories
  close(): void
}
