// The delivery service's table (docs/specs/delivery.md, ADR-0024 §5, ADR-0027 §16).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One row per delivery run. `id` is the run id: a second create with the same id returns the stored row, which is the
 * exactly-once guard. `text` is blanked when the row becomes `delivered`. `status` is `pending`, `held` (kept for the return digest), `delivered`
 * or `failed`. JSON columns are text. No foreign keys: a removed person's rows follow the removal registry (ADR-0027 §26).
 */
export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    recipientId: text('recipient_id').notNull(),
    billTo: text('bill_to'),
    name: text('name').notNull(),
    /** The `needs` of the request, JSON. */
    needs: text('needs').notNull(),
    /** The optional `data` of the request, JSON. */
    data: text('data'),
    text: text('text').notNull(),
    reportTo: text('report_to'),
    reportText: text('report_text'),
    reportKey: text('report_key'),
    status: text('status').notNull(),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    route: text('route'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('deliveries_due').on(t.status, t.nextAttemptAt)],
)
