// reminders repository (phase 4, docs/architecture/storage.md#reminders-and-thread-cursors-phase-4).

import { and, asc, count, eq, lte } from 'drizzle-orm'
import type { Reminder } from '../shared/types.ts'
import type { Orm } from './orm.ts'
import { reminders } from './schema.ts'
import type { RemindersRepository } from './types.ts'

type ReminderRow = typeof reminders.$inferSelect

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    personId: row.personId,
    threadId: row.threadId,
    text: row.text,
    dueAt: row.dueAt,
    status: row.status,
    createdAt: row.createdAt,
    firedAt: row.firedAt,
    cancelledAt: row.cancelledAt,
    deliveryId: row.deliveryId,
  }
}

const pending = eq(reminders.status, 'pending')
const soonestFirst = [asc(reminders.dueAt), asc(reminders.id)]

export function createRemindersRepository(db: Orm): RemindersRepository {
  return {
    async create(r) {
      db.insert(reminders).values(r).run()
    },
    async get(id) {
      const row = db.select().from(reminders).where(eq(reminders.id, id)).get()
      return row ? toReminder(row) : null
    },
    async listDue(now, limit) {
      if (limit !== undefined && limit <= 0) return []
      const query = db
        .select()
        .from(reminders)
        .where(and(pending, lte(reminders.dueAt, now)))
        .orderBy(...soonestFirst)
      return (limit === undefined ? query.all() : query.limit(limit).all()).map(toReminder)
    },
    async listPending(personId) {
      return db
        .select()
        .from(reminders)
        .where(and(pending, eq(reminders.personId, personId)))
        .orderBy(...soonestFirst)
        .all()
        .map(toReminder)
    },
    async countPending(personId) {
      const row = db
        .select({ n: count() })
        .from(reminders)
        .where(and(pending, eq(reminders.personId, personId)))
        .get()
      return row?.n ?? 0
    },
    // Conditional updates: only a pending reminder changes, so a second call returns false.
    async markFired(id, at, deliveryId) {
      const result = db
        .update(reminders)
        .set({ status: 'fired', firedAt: at, deliveryId })
        .where(and(eq(reminders.id, id), pending))
        .run()
      return result.changes > 0
    },
    async cancel(id, at) {
      const result = db
        .update(reminders)
        .set({ status: 'cancelled', cancelledAt: at })
        .where(and(eq(reminders.id, id), pending))
        .run()
      return result.changes > 0
    },
  }
}
