// threads + thread_participants repository.

import { KeithError } from '@keith/sdk'
import { and, asc, desc, eq, gt, isNull, lte, type SQL, sql } from 'drizzle-orm'
import type { Orm } from './orm.ts'
import { messages, threadParticipants, threads } from './schema.ts'
import type { ThreadRecord, ThreadsRepository } from './types.ts'

type ThreadRow = typeof threads.$inferSelect

function toThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    ownerPersonId: row.ownerPersonId,
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    summaryThroughSeq: row.summaryThroughSeq,
    reflectedThroughSeq: row.reflectedThroughSeq,
  }
}

/** `"table"."column"`, always qualified (Drizzle drops the table name of columns in a select list). */
function qualified(table: string, column: { name: string }): SQL {
  return sql`${sql.identifier(table)}.${sql.identifier(column.name)}`
}

/**
 * The thread's highest message `seq` (0 without messages), a correlated subquery that uses the
 * (thread_id, seq) index. Columns are qualified by hand: in a select list Drizzle would print
 * `"id"`, which inside the subquery resolves to `messages.id`.
 */
const lastSeqOfThread: SQL<number> = sql<number>`(select coalesce(max(${qualified('messages', messages.seq)}), 0) from ${messages} where ${qualified('messages', messages.threadId)} = ${qualified('threads', threads.id)})`

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `${what} not implemented yet (P5-S1)`)
}

export function createThreadsRepository(db: Orm): ThreadsRepository {
  return {
    // Phase 5 placeholders: P5-S1 implements them (JSDoc in types.ts) and adds `purpose`.
    async addParticipant() {
      throw notImplemented('threads.addParticipant')
    },
    async removeParticipant() {
      throw notImplemented('threads.removeParticipant')
    },
    async formerParticipants() {
      throw notImplemented('threads.formerParticipants')
    },
    async create(t, participants) {
      db.transaction((tx) => {
        tx.insert(threads)
          .values({
            ...t,
            summaryThroughSeq: t.summaryThroughSeq ?? null,
            reflectedThroughSeq: t.reflectedThroughSeq ?? null,
          })
          .run()
        if (participants.length > 0) {
          tx.insert(threadParticipants)
            .values(
              participants.map((personId) => ({
                threadId: t.id,
                personId,
                joinedAt: t.createdAt,
                leftAt: null,
              })),
            )
            .run()
        }
      })
    },
    async get(id) {
      const row = db.select().from(threads).where(eq(threads.id, id)).get()
      return row ? toThread(row) : null
    },
    async getBySlug(ownerPersonId, slug) {
      const row = db
        .select()
        .from(threads)
        .where(and(eq(threads.ownerPersonId, ownerPersonId), eq(threads.slug, slug)))
        .get()
      return row ? toThread(row) : null
    },
    async listForPerson(personId) {
      return db
        .select({ thread: threads })
        .from(threads)
        .innerJoin(threadParticipants, eq(threadParticipants.threadId, threads.id))
        .where(and(eq(threadParticipants.personId, personId), isNull(threadParticipants.leftAt)))
        .orderBy(desc(threads.updatedAt), desc(threads.id))
        .all()
        .map((r) => toThread(r.thread))
    },
    async participants(threadId) {
      return db
        .select()
        .from(threadParticipants)
        .where(and(eq(threadParticipants.threadId, threadId), isNull(threadParticipants.leftAt)))
        .orderBy(asc(threadParticipants.joinedAt), asc(threadParticipants.personId))
        .all()
    },
    async touch(id, updatedAt) {
      db.update(threads).set({ updatedAt }).where(eq(threads.id, id)).run()
    },
    async setSummary(id, { summary, throughSeq }) {
      db.update(threads).set({ summary, summaryThroughSeq: throughSeq }).where(eq(threads.id, id)).run()
    },
    async setReflectedThrough(id, seq) {
      db.update(threads).set({ reflectedThroughSeq: seq }).where(eq(threads.id, id)).run()
    },
    async listForReflection({ idleBefore, limit }) {
      if (limit <= 0) return []
      return db
        .select({ thread: threads, lastSeq: lastSeqOfThread })
        .from(threads)
        .where(
          and(
            lte(threads.updatedAt, idleBefore),
            gt(lastSeqOfThread, sql`coalesce(${threads.reflectedThroughSeq}, 0)`),
          ),
        )
        .orderBy(asc(threads.updatedAt), asc(threads.id))
        .limit(limit)
        .all()
        .map((r) => ({ thread: toThread(r.thread), lastSeq: r.lastSeq }))
    },
  }
}
