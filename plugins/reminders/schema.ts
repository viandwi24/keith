import { index, integer, sqliteTable, text } from '@keith/host/schema'

/**
 * A reminder. Who may read or cancel it lives in the ACL (kind `reminder`, class `action`; owner = the creator, an
 * `r` entry for the recipient); the timer lives in the host scheduler under the key = `id`. This table is the
 * authority for what a fire does: the host only says "slot X of timer <id> is due".
 */
export const reminders = sqliteTable(
  'plg_reminders_items',
  {
    id: text('id').primaryKey(),
    creatorId: text('creator_id').notNull(),
    recipientId: text('recipient_id').notNull(),
    text: text('text').notNull(),
    /** `once` (at `when_at`) or `cron` (`when_expr`, core time zone). */
    whenKind: text('when_kind').notNull(),
    whenAt: integer('when_at'),
    whenExpr: text('when_expr'),
    /** `active`, `done` (a once reminder that fired) or `ended` (cancelled, or skipped for good: see `ended_reason`). */
    status: text('status').notNull(),
    endedReason: text('ended_reason'),
    /** The last slot that fired (a retried slot never fires twice). */
    lastSlot: integer('last_slot'),
    lastFireAt: integer('last_fire_at'),
    fireCount: integer('fire_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('plg_reminders_items_creator').on(t.creatorId, t.status),
    index('plg_reminders_items_recipient').on(t.recipientId, t.status),
  ],
)

/**
 * One fire of a reminder (P25, ADR-0027 §16). `claimed` is written in the same transaction as the reminder's
 * `last_slot`, before the wake; `accepted` once the delivery service took the wake (delivered or queued). A
 * `claimed` row found at a boot is resumed with the same fire id, which the delivery service answers once. The
 * per-creator hourly rate limit counts these rows (F-021), and rows older than 48 hours are pruned.
 */
export const fires = sqliteTable(
  'plg_reminders_fires',
  {
    fireId: text('fire_id').primaryKey(),
    reminderId: text('reminder_id').notNull(),
    creatorId: text('creator_id').notNull(),
    /** The slot this fire is for (epoch ms). */
    slot: integer('slot').notNull(),
    firedAt: integer('fired_at').notNull(),
    /** `claimed` or `accepted`. */
    state: text('state').notNull(),
  },
  (t) => [
    index('plg_reminders_fires_fired').on(t.firedAt),
    index('plg_reminders_fires_creator').on(t.creatorId, t.firedAt),
  ],
)
