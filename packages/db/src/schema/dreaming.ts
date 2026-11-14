// The memory dreaming tables (docs/specs/dreaming.md, ADR-0031 §5, §8, P35.2.1). `dream_settings` holds one row per person who
// set a mode; an absent row means the default (`propose` for the owner, the member default otherwise). `dream_runs` holds one
// row per run; the cadence anchor and the cursor come from its rows. No foreign key (as `front_generations`): a removed
// person's rows are deleted by the dreaming removal part, never by time.
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The mode of one person. `updated_by` is the person who wrote it (the person, or the owner through the audited path). */
export const dreamSettings = sqliteTable(
  'dream_settings',
  {
    personId: text('person_id').primaryKey(),
    mode: text('mode').notNull(),
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [check('dream_settings_mode_known', sql`${t.mode} IN ('off', 'propose', 'auto')`)],
)

/**
 * One dreaming run. `trigger` is what started it (`schedule` or `manual`); `status` is `running` while it runs, then `applied`,
 * `staged`, `skipped` (no model call), `refused`, `failed` or `rejected` (the judge's plan was not accepted). `counts` and
 * `cursor` are JSON; `cursor` maps each session to the last message id collected. `undo_until` is set by an `auto` apply.
 */
export const dreamRuns = sqliteTable(
  'dream_runs',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').notNull(),
    trigger: text('trigger').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    counts: text('counts').notNull().default('{}'),
    cursor: text('cursor').notNull().default('{}'),
    undoUntil: integer('undo_until'),
  },
  (t) => [
    index('dream_runs_person_started').on(t.personId, t.startedAt),
    check('dream_runs_trigger_known', sql`${t.trigger} IN ('schedule', 'manual')`),
    check('dream_runs_mode_known', sql`${t.mode} IN ('off', 'propose', 'auto')`),
    check(
      'dream_runs_status_known',
      sql`${t.status} IN ('running', 'applied', 'staged', 'skipped', 'refused', 'failed', 'rejected')`,
    ),
  ],
)
