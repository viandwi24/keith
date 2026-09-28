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
  Reminder,
  ReminderId,
  Task,
  TaskId,
  TaskStatus,
  ThreadId,
  ThreadInvitation,
  ThreadInvitationStatus,
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
  /** Deletes every token of the person (ends all their sessions). Returns the number deleted. */
  deleteForPerson(personId: PersonId): Promise<number>
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
   * same thread and person, or an `accepted` row for someone who is no longer a current participant
   * (they left), it is replaced (a re-invitation). Returns false, and changes nothing, when a
   * `pending` row exists or the person is a current participant.
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
