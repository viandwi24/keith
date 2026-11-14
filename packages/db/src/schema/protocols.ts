// The hypothalamus tables: protocols and their versions, runs and run steps, proposals, and the personal agenda
// (docs/specs/hypothalamus.md, "Data model", ADR-0024, ADR-0025 §2). The definitions are JSON parsed by the contracts
// (`ProtocolDefinitionSchema`, `ProposalDefinitionSchema`). `owner` and `person` are person ids or `keith`; they are
// not foreign keys to `people` (a removed person's rows follow the removal registry, ADR-0027 §26), except where a
// table names a parent of its own (versions, run steps).
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * A protocol: the head of its history. `owner` is `keith` or a person id; `built_in` names a seeded protocol (one per
 * owner, unique with `owner`); `version` is the current version, moved by compare-and-set on every save.
 */
export const protocols = sqliteTable(
  'protocols',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    /** null, `approval-stale`, `reminder-missed` or `owner-absence`. */
    builtIn: text('built_in'),
    /** 1 = the engine may start its runs, 0 = off. */
    enabled: integer('enabled').notNull().default(1),
    /** Epoch ms until which the protocol is paused; null when not paused. */
    pausedUntil: integer('paused_until'),
    version: integer('version').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('protocols_owner_name').on(t.owner, t.name),
    uniqueIndex('protocols_owner_built_in').on(t.owner, t.builtIn),
  ],
)

/**
 * One saved version of a protocol. An edit writes a new row and the old rows stay (the audit of what ran). `approvals`
 * is a JSON list with one entry per `act` step: the step id, the SHA-256 of the exact input, who approved and when.
 */
export const protocolVersions = sqliteTable(
  'protocol_versions',
  {
    protocolId: text('protocol_id')
      .notNull()
      .references(() => protocols.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: text('definition').notNull(),
    approvals: text('approvals').notNull().default('[]'),
    savedBy: text('saved_by').notNull(),
    savedAt: integer('saved_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.protocolId, t.version] })],
)

/**
 * One run of a protocol for one person. `id` is a UUIDv7 and the delivery key root of P25. `(protocol_id, trigger_ref)`
 * is the exactly-once guard of a trigger: a second start with the same trigger returns the stored run. `status` is
 * `running`, `waiting`, `done`, `cancelled`, `failed`, `skipped` or `expired`; `wake_at` is absolute (ms, null when
 * nothing is due). JSON columns are text. No foreign key to `protocols`: a run's history outlives its protocol's edits.
 */
export const protocolRuns = sqliteTable(
  'protocol_runs',
  {
    id: text('id').primaryKey(),
    protocolId: text('protocol_id').notNull(),
    version: integer('version').notNull(),
    person: text('person').notNull(),
    /** The fire id, `absence:<lastSignAt>`, a signal id or an event sequence. */
    triggerRef: text('trigger_ref').notNull(),
    status: text('status').notNull(),
    step: text('step'),
    /** JSON counts of executions per step id. */
    visits: text('visits').notNull().default('{}'),
    /** JSON answers of `ask` steps, by step id (the option or the text length, never the text). */
    answers: text('answers').notNull().default('{}'),
    wakeAt: integer('wake_at'),
    costUsd: real('cost_usd').notNull().default(0),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [
    uniqueIndex('protocol_runs_trigger').on(t.protocolId, t.triggerRef),
    index('protocol_runs_due').on(t.status, t.wakeAt),
    index('protocol_runs_person').on(t.person, t.startedAt),
  ],
)

/**
 * The history of a run, one row per step execution. `n` is the AUTOINCREMENT order. `outcome` is `started` first, then
 * `ok`, `answered:<x>`, `timeout`, `refused:<reason>`, `failed:<reason>` or `unknown`. `detail` is JSON of ids, lengths
 * and reasons; it never holds message text.
 */
export const protocolRunSteps = sqliteTable(
  'protocol_run_steps',
  {
    n: integer('n').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => protocolRuns.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    at: integer('at').notNull(),
    detail: text('detail'),
  },
  (t) => [index('protocol_run_steps_run').on(t.runId, t.n)],
)

/**
 * A protocol Keith suggests from what a person said. It is data, never a protocol: confirming it is a person action
 * that validates it again. `status` is `pending`, `confirmed`, `dismissed` or `expired` (7 days after `created_at`).
 * `source` is JSON of the session and message ids the suggestion came from.
 */
export const protocolProposals = sqliteTable(
  'protocol_proposals',
  {
    id: text('id').primaryKey(),
    person: text('person').notNull(),
    definition: text('definition').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('protocol_proposals_person').on(t.person, t.status),
    index('protocol_proposals_expiry').on(t.status, t.expiresAt),
  ],
)

/**
 * The personal agenda: what a person will do and when (ADR-0025 §2). Only the person reads it, and the owner with an
 * audit row. `status` is `tentative` (not yet confirmed; never busy), `confirmed`, `done`, `cancelled` or `dismissed`.
 * A null `ends_at` means one hour from `starts_at` for the purpose of busy and retention. No foreign key to `people`.
 */
export const agendaItems = sqliteTable(
  'agenda_items',
  {
    id: text('id').primaryKey(),
    person: text('person').notNull(),
    what: text('what').notNull(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at'),
    place: text('place'),
    status: text('status').notNull(),
    sourceSession: text('source_session'),
    sourceMessage: text('source_message'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('agenda_items_person').on(t.person, t.startsAt)],
)
