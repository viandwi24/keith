// tasks, commitments and deliveries repositories.

import { UiBlock } from '@keith/protocol'
import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm'
import type { Commitment, Delivery, Task } from '../shared/types.ts'
import { definedOnly, type Orm, parseJsonOrNull, toJsonOrNull } from './orm.ts'
import { commitments, deliveries, tasks } from './schema.ts'
import type { CommitmentsRepository, DeliveriesRepository, TasksRepository } from './types.ts'

type TaskRow = typeof tasks.$inferSelect

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    personId: row.personId,
    threadId: row.threadId,
    agentId: row.agentId,
    goal: row.goal,
    status: row.status,
    attempt: row.attempt,
    visibility: row.visibility,
    summary: row.summary,
    detail: row.detail,
    ui: parseJsonOrNull(UiBlock, row.ui, { table: 'tasks', column: 'ui', id: row.id }),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

export function createTasksRepository(db: Orm): TasksRepository {
  return {
    async create(t) {
      db.insert(tasks)
        .values({ ...t, ui: toJsonOrNull(t.ui) })
        .run()
    },
    async get(id) {
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get()
      return row ? toTask(row) : null
    },
    async update(id, patch) {
      const { ui, ...rest } = patch
      const set = { ...definedOnly(rest), ...(ui === undefined ? {} : { ui: toJsonOrNull(ui) }) }
      if (Object.keys(set).length === 0) return
      db.update(tasks).set(set).where(eq(tasks.id, id)).run()
    },
    async listByStatus(statuses) {
      if (statuses.length === 0) return []
      return db
        .select()
        .from(tasks)
        .where(inArray(tasks.status, statuses))
        .orderBy(asc(tasks.createdAt), asc(tasks.id))
        .all()
        .map(toTask)
    },
    async countActiveFor(personId) {
      const row = db
        .select({ n: count() })
        .from(tasks)
        .where(and(eq(tasks.personId, personId), inArray(tasks.status, ['queued', 'running'])))
        .get()
      return row?.n ?? 0
    },
  }
}

function toCommitment(row: typeof commitments.$inferSelect): Commitment {
  return { ...row }
}

export function createCommitmentsRepository(db: Orm): CommitmentsRepository {
  return {
    async create(c) {
      db.insert(commitments).values(c).run()
    },
    async get(id) {
      const row = db.select().from(commitments).where(eq(commitments.id, id)).get()
      return row ? toCommitment(row) : null
    },
    async resolve(id, status, resolvedAt) {
      db.update(commitments)
        .set({ status, resolvedAt })
        .where(and(eq(commitments.id, id), eq(commitments.status, 'open')))
        .run()
    },
    async openForTask(taskId) {
      const row = db
        .select()
        .from(commitments)
        .where(and(eq(commitments.taskId, taskId), eq(commitments.status, 'open')))
        .orderBy(asc(commitments.createdAt), asc(commitments.id))
        .get()
      return row ? toCommitment(row) : null
    },
    async openForThread(threadId) {
      return db
        .select()
        .from(commitments)
        .where(and(eq(commitments.threadId, threadId), eq(commitments.status, 'open')))
        .orderBy(asc(commitments.createdAt), asc(commitments.id))
        .all()
        .map(toCommitment)
    },
    async listExpired(now) {
      return db
        .select()
        .from(commitments)
        .where(and(eq(commitments.status, 'open'), lte(commitments.expiresAt, now)))
        .orderBy(asc(commitments.expiresAt), asc(commitments.id))
        .all()
        .map(toCommitment)
    },
  }
}

type DeliveryRow = typeof deliveries.$inferSelect

function toDelivery(row: DeliveryRow): Delivery {
  return {
    ...row,
    ui: parseJsonOrNull(UiBlock, row.ui, { table: 'deliveries', column: 'ui', id: row.id }),
  }
}

/** Critical first (0), low last (3). */
const urgencyRank = sql`case ${deliveries.urgency} when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`

export function createDeliveriesRepository(db: Orm): DeliveriesRepository {
  return {
    async create(d) {
      db.insert(deliveries)
        .values({ ...d, ui: toJsonOrNull(d.ui) })
        .run()
    },
    async get(id) {
      const row = db.select().from(deliveries).where(eq(deliveries.id, id)).get()
      return row ? toDelivery(row) : null
    },
    async pendingFor(threadId) {
      return db
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.threadId, threadId), eq(deliveries.status, 'pending')))
        .orderBy(urgencyRank, asc(deliveries.createdAt), asc(deliveries.id))
        .all()
        .map(toDelivery)
    },
    // Placeholder (P3-K2): the optional `messageId` is ignored; P3-H3 stores it (D4).
    async markDelivered(ids, deliveredAt) {
      if (ids.length === 0) return
      db.update(deliveries)
        .set({ status: 'delivered', deliveredAt })
        .where(and(inArray(deliveries.id, ids), eq(deliveries.status, 'pending')))
        .run()
    },
  }
}
