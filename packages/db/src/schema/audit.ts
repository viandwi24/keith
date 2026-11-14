// Security log and activity feed (docs/specs/db.md).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Append-only security log (`PersonEvent` shape). `detail` is JSON and never holds secrets. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    /** A person id, or `system`. */
    actor: text('actor').notNull(),
    /** local | tcp | offline */
    via: text('via').notNull(),
    detail: text('detail').notNull(),
  },
  (t) => [index('audit_events_at').on(t.at)],
)

/** Append-only activity feed (eharness `ActivityStore`); `seq` is AUTOINCREMENT, never reused. */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    /** JSON object. */
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('events_type').on(t.type, t.seq), index('events_session').on(t.sessionId, t.seq)],
)
