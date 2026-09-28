// Drizzle schema for every phase-1 to phase-5 table in docs/architecture/storage.md. drizzle-kit reads this file
// (packages/core/drizzle.config.ts) to generate migrations; never edit a generated migration.
// JSON columns are plain text here; repositories parse them with zod on read (R-9).
// `memories_fts` is an FTS5 virtual table created by a custom migration, not declared here.

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type {
  CommitmentId,
  DeliveryId,
  FileId,
  MemoryId,
  MessageId,
  NodeId,
  PersonId,
  ReminderId,
  TaskId,
  ThreadId,
} from '../shared/types.ts'

export const TIERS = ['owner', 'member', 'guest'] as const
export const NODE_KINDS = ['attended', 'headless'] as const
export const THREAD_KINDS = ['direct', 'group'] as const
export const MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const
export const MODALITIES = ['text', 'audio'] as const
export const TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
export const VISIBILITIES = ['subject', 'thread', 'household', 'owner'] as const
export const COMMITMENT_STATUSES = ['open', 'fulfilled', 'cancelled', 'expired'] as const
export const DELIVERY_KINDS = [
  'task_result',
  'task_failed',
  'plugin',
  'reminder',
  'relay',
  'invitation',
] as const
export const URGENCY_LEVELS = ['low', 'normal', 'high', 'critical'] as const
export const DELIVERY_STATUSES = ['pending', 'delivered', 'dismissed'] as const
export const MEMORY_SOURCES = ['stated', 'inferred', 'relayed', 'plugin'] as const
export const REMINDER_STATUSES = ['pending', 'fired', 'cancelled'] as const
export const THREAD_INVITATION_STATUSES = ['pending', 'accepted', 'declined'] as const

export const persons = sqliteTable(
  'persons',
  {
    id: text('id').$type<PersonId>().primaryKey(),
    name: text('name').notNull(),
    username: text('username').unique(),
    passwordHash: text('password_hash'),
    tier: text('tier', { enum: TIERS }).notNull(),
    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
  },
  // Phase 5: names are unique case-insensitively (SQLite `lower()` folds ASCII only).
  (t) => [uniqueIndex('persons_name_lower_idx').on(sql`lower(${t.name})`)],
)

export const relationships = sqliteTable('relationships', {
  personId: text('person_id')
    .$type<PersonId>()
    .primaryKey()
    .references(() => persons.id, { onDelete: 'cascade' }),
  tone: text('tone').notNull(),
  notes: text('notes').notNull(),
  /** JSON: PersonId[]. */
  blockedRelayFrom: text('blocked_relay_from').notNull(),
})

export const authTokens = sqliteTable(
  'auth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').$type<NodeId>(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('auth_tokens_expires_at_idx').on(t.expiresAt)],
)

export const nodes = sqliteTable('nodes', {
  id: text('id').$type<NodeId>().primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: NODE_KINDS }).notNull(),
  /** JSON: string[]. */
  capabilities: text('capabilities').notNull(),
  lastSeenAt: integer('last_seen_at'),
})

export const threads = sqliteTable(
  'threads',
  {
    id: text('id').$type<ThreadId>().primaryKey(),
    kind: text('kind', { enum: THREAD_KINDS }).notNull(),
    slug: text('slug'),
    title: text('title').notNull(),
    ownerPersonId: text('owner_person_id')
      .$type<PersonId>()
      .references(() => persons.id),
    summary: text('summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Phase 4: the last message `seq` that `summary` covers; null = no summary yet. */
    summaryThroughSeq: integer('summary_through_seq'),
    /** Phase 4: the last message `seq` that reflection has read; null = never reflected. */
    reflectedThroughSeq: integer('reflected_through_seq'),
    /** Phase 5: what a group thread is for; null for direct threads and groups without one. */
    purpose: text('purpose'),
  },
  (t) => [uniqueIndex('threads_owner_slug_idx').on(t.ownerPersonId, t.slug)],
)

export const threadParticipants = sqliteTable(
  'thread_participants',
  {
    threadId: text('thread_id')
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    joinedAt: integer('joined_at').notNull(),
    leftAt: integer('left_at'),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.personId] }),
    index('thread_participants_person_idx').on(t.personId),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').$type<MessageId>().primaryKey(),
    threadId: text('thread_id')
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    authorPersonId: text('author_person_id')
      .$type<PersonId>()
      .references(() => persons.id),
    nodeId: text('node_id').$type<NodeId>(),
    modality: text('modality', { enum: MODALITIES }).notNull(),
    content: text('content').notNull(),
    /** JSON: LlmToolCall[] (assistant only). */
    toolCalls: text('tool_calls'),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    isError: integer('is_error', { mode: 'boolean' }),
    /** JSON: MessageUiEntry[] (assistant only). */
    ui: text('ui'),
    /** JSON: MessageMeta. */
    meta: text('meta'),
    /** Position in the thread (1, 2, ...). Assigned by the repository on insert; defines order. */
    seq: integer('seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('messages_thread_seq_idx').on(t.threadId, t.seq)],
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').$type<TaskId>().primaryKey(),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id),
    threadId: text('thread_id')
      .$type<ThreadId>()
      .references(() => threads.id),
    agentId: text('agent_id').notNull(),
    goal: text('goal').notNull(),
    status: text('status', { enum: TASK_STATUSES }).notNull(),
    attempt: integer('attempt').notNull(),
    summary: text('summary'),
    detail: text('detail'),
    /** JSON: UiBlock. */
    ui: text('ui'),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull(),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('tasks_status_created_idx').on(t.status, t.createdAt),
    index('tasks_person_status_idx').on(t.personId, t.status),
  ],
)

export const commitments = sqliteTable(
  'commitments',
  {
    id: text('id').$type<CommitmentId>().primaryKey(),
    threadId: text('thread_id')
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id),
    taskId: text('task_id')
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    promise: text('promise').notNull(),
    status: text('status', { enum: COMMITMENT_STATUSES }).notNull(),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('commitments_task_idx').on(t.taskId),
    index('commitments_thread_status_idx').on(t.threadId, t.status),
    index('commitments_status_expires_idx').on(t.status, t.expiresAt),
  ],
)

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').$type<DeliveryId>().primaryKey(),
    threadId: text('thread_id')
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id),
    kind: text('kind', { enum: DELIVERY_KINDS }).notNull(),
    authorPersonId: text('author_person_id')
      .$type<PersonId>()
      .references(() => persons.id),
    source: text('source').notNull(),
    urgency: text('urgency', { enum: URGENCY_LEVELS }).notNull(),
    content: text('content').notNull(),
    /** JSON: UiBlock. */
    ui: text('ui'),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
    /** The assistant message that delivered the item; null while pending. */
    messageId: text('message_id')
      .$type<MessageId>()
      .references(() => messages.id, { onDelete: 'set null' }),
  },
  (t) => [index('deliveries_thread_status_idx').on(t.threadId, t.status)],
)

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').$type<MemoryId>().primaryKey(),
    content: text('content').notNull(),
    subjectPersonId: text('subject_person_id')
      .$type<PersonId>()
      .references(() => persons.id),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull(),
    threadId: text('thread_id')
      .$type<ThreadId>()
      .references(() => threads.id),
    source: text('source', { enum: MEMORY_SOURCES }).notNull(),
    authorPersonId: text('author_person_id')
      .$type<PersonId>()
      .references(() => persons.id),
    pinned: integer('pinned', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastRecalledAt: integer('last_recalled_at'),
  },
  (t) => [
    index('memories_visibility_idx').on(t.visibility),
    index('memories_subject_idx').on(t.subjectPersonId),
    index('memories_thread_idx').on(t.threadId),
  ],
)

export const pluginData = sqliteTable(
  'plugin_data',
  {
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    /** JSON: any JSON value. */
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.key] })],
)

export const files = sqliteTable(
  'files',
  {
    id: text('id').$type<FileId>().primaryKey(),
    /** Original file name. */
    name: text('name').notNull(),
    /** Relative to `KEITH_HOME/files/`. */
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    ownerPersonId: text('owner_person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('files_owner_idx').on(t.ownerPersonId)],
)

export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').$type<ReminderId>().primaryKey(),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    /** Null = the person's `main` thread. */
    threadId: text('thread_id')
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    dueAt: integer('due_at').notNull(),
    status: text('status', { enum: REMINDER_STATUSES }).notNull(),
    createdAt: integer('created_at').notNull(),
    firedAt: integer('fired_at'),
    cancelledAt: integer('cancelled_at'),
    /** The `reminder` delivery it fired as; null until fired. */
    deliveryId: text('delivery_id')
      .$type<DeliveryId>()
      .references(() => deliveries.id, { onDelete: 'set null' }),
  },
  (t) => [index('reminders_status_due_idx').on(t.status, t.dueAt)],
)

/** Phase 5: single-use invite links. Only the SHA-256 of the code is stored (R-14). */
export const inviteLinks = sqliteTable(
  'invite_links',
  {
    codeHash: text('code_hash').primaryKey(),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('invite_links_person_idx').on(t.personId)],
)

/** Phase 5: invitations to group threads, one row per (thread, person). */
export const threadInvitations = sqliteTable(
  'thread_invitations',
  {
    threadId: text('thread_id')
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    invitedBy: text('invited_by')
      .$type<PersonId>()
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    status: text('status', { enum: THREAD_INVITATION_STATUSES }).notNull(),
    /** The `invitation` delivery; null when it is gone or not made yet. */
    deliveryId: text('delivery_id')
      .$type<DeliveryId>()
      .references(() => deliveries.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.personId] }),
    index('thread_invitations_person_status_idx').on(t.personId, t.status),
  ],
)
