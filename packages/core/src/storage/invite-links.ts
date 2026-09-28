// invite_links repository (phase 5, docs/architecture/storage.md#invite-links-and-group-invitations-phase-5).

import { and, eq, isNull } from 'drizzle-orm'
import type { Orm } from './orm.ts'
import { inviteLinks } from './schema.ts'
import type { InviteLinkRecord, InviteLinksRepository } from './types.ts'

type InviteLinkRow = typeof inviteLinks.$inferSelect

function toInviteLink(row: InviteLinkRow): InviteLinkRecord {
  return {
    codeHash: row.codeHash,
    personId: row.personId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  }
}

export function createInviteLinksRepository(db: Orm): InviteLinksRepository {
  return {
    async create(l) {
      db.insert(inviteLinks).values(l).run()
    },
    async get(codeHash) {
      const row = db.select().from(inviteLinks).where(eq(inviteLinks.codeHash, codeHash)).get()
      return row ? toInviteLink(row) : null
    },
    // Conditional update: only an unused link changes, so of two requests with one code only
    // the first wins.
    async markUsed(codeHash, at) {
      const result = db
        .update(inviteLinks)
        .set({ usedAt: at })
        .where(and(eq(inviteLinks.codeHash, codeHash), isNull(inviteLinks.usedAt)))
        .run()
      return result.changes > 0
    },
    async revokeFor(personId) {
      const result = db
        .delete(inviteLinks)
        .where(and(eq(inviteLinks.personId, personId), isNull(inviteLinks.usedAt)))
        .run()
      return result.changes
    },
  }
}
