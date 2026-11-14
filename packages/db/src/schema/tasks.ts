// Task board and owner reviews (docs/specs/db.md).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Task board: one row per delegated worker. The id is the child session id. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    parentSessionId: text('parent_session_id').notNull(),
    /** Catalog key of the worker agent, e.g. `cortex.research`. */
    agent: text('agent').notNull(),
    description: text('description').notNull(),
    /** queued | running | waiting | done | failed | stopped | timed_out | interrupted */
    status: text('status').notNull(),
    steps: integer('steps').notNull().default(0),
    summary: text('summary'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('tasks_parent').on(t.parentSessionId, t.updatedAt)],
)

/**
 * Operations waiting for the owner (docs/specs/plugins.md, "Owner review queue"). `payload` is the validated
 * input as JSON; the owner reads it as data and approval replays it as `requester`. `status` is
 * `pending | approved | denied | expired`; `reason` is the requester's note, or the owner's on a denial;
 * `outcome` is `ok` or `error:<code>` once an approved operation ran. No foreign keys: a person who left keeps their rows.
 */
export const ownerReviews = sqliteTable(
  'owner_reviews',
  {
    id: text('id').primaryKey(),
    requester: text('requester').notNull(),
    plugin: text('plugin').notNull(),
    operation: text('operation').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    outcome: text('outcome'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [
    index('owner_reviews_status').on(t.status, t.createdAt),
    index('owner_reviews_requester').on(t.requester, t.status),
  ],
)
