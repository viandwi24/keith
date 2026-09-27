// threads + thread_participants repository.

import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { Orm } from './orm.ts'
import { threadParticipants, threads } from './schema.ts'
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
  }
}

export function createThreadsRepository(db: Orm): ThreadsRepository {
  return {
    async create(t, participants) {
      db.transaction((tx) => {
        tx.insert(threads).values(t).run()
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
  }
}
