// The succession state: the one row of the owner-absence run (docs/specs/succession.md, "States", ADR-0022 §3). `id` is
// always 1 and `state` is one of the five states; the claim re-reads this row inside its transaction, so the row is the
// guard of the transfer. Kept on purpose: the audit holds the history, and the row is replaced by the next run.

import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const successionState = sqliteTable(
  'succession_state',
  {
    id: integer('id').primaryKey(),
    /** `idle`, `check-in`, `grace`, `claimable` or `claimed`. */
    state: text('state').notNull(),
    /** The P28 run of `owner-absence` that the state belongs to (null while idle before any run). */
    runId: text('run_id'),
    /** The heir (a person id) at the moment the run started. */
    heir: text('heir'),
    startedAt: integer('started_at'),
    graceStartedAt: integer('grace_started_at'),
    claimableAt: integer('claimable_at'),
    /** The sign of life of the owner that was read when the run started (epoch ms, null when none was known). */
    lastSignAt: integer('last_sign_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('succession_state_single', sql`${t.id} = 1`),
    check(
      'succession_state_known',
      sql`${t.state} IN ('idle', 'check-in', 'grace', 'claimable', 'claimed')`,
    ),
  ],
)
