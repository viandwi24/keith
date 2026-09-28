// thread_invitations repository (phase 5, docs/architecture/storage.md#invite-links-and-group-invitations-phase-5).

import { and, asc, eq } from 'drizzle-orm'
import type { ThreadInvitation } from '../shared/types.ts'
import type { Orm } from './orm.ts'
import { threadInvitations } from './schema.ts'
import type { ThreadInvitationsRepository } from './types.ts'

type ThreadInvitationRow = typeof threadInvitations.$inferSelect

function toInvitation(row: ThreadInvitationRow): ThreadInvitation {
  return {
    threadId: row.threadId,
    personId: row.personId,
    invitedBy: row.invitedBy,
    status: row.status,
    deliveryId: row.deliveryId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  }
}

const pending = eq(threadInvitations.status, 'pending')

export function createThreadInvitationsRepository(db: Orm): ThreadInvitationsRepository {
  return {
    // One statement: inserts, or replaces only a `declined` row (a re-invitation). A `pending`
    // or `accepted` row makes the upsert a no-op, so `changes` is 0.
    async create(inv) {
      const result = db
        .insert(threadInvitations)
        .values(inv)
        .onConflictDoUpdate({
          target: [threadInvitations.threadId, threadInvitations.personId],
          set: {
            invitedBy: inv.invitedBy,
            status: inv.status,
            deliveryId: inv.deliveryId,
            createdAt: inv.createdAt,
            resolvedAt: inv.resolvedAt,
          },
          setWhere: eq(threadInvitations.status, 'declined'),
        })
        .run()
      return result.changes > 0
    },
    async get(threadId, personId) {
      const row = db
        .select()
        .from(threadInvitations)
        .where(and(eq(threadInvitations.threadId, threadId), eq(threadInvitations.personId, personId)))
        .get()
      return row ? toInvitation(row) : null
    },
    async pendingForThread(threadId) {
      return db
        .select()
        .from(threadInvitations)
        .where(and(pending, eq(threadInvitations.threadId, threadId)))
        .orderBy(asc(threadInvitations.createdAt), asc(threadInvitations.personId))
        .all()
        .map(toInvitation)
    },
    async pendingForPerson(personId) {
      return db
        .select()
        .from(threadInvitations)
        .where(and(pending, eq(threadInvitations.personId, personId)))
        .orderBy(asc(threadInvitations.createdAt), asc(threadInvitations.threadId))
        .all()
        .map(toInvitation)
    },
    // Conditional update: only a pending invitation changes.
    async resolve(threadId, personId, status, at) {
      const result = db
        .update(threadInvitations)
        .set({ status, resolvedAt: at })
        .where(
          and(eq(threadInvitations.threadId, threadId), eq(threadInvitations.personId, personId), pending),
        )
        .run()
      return result.changes > 0
    },
  }
}
