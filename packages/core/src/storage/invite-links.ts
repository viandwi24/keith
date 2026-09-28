// invite_links repository (phase 5, docs/architecture/storage.md#invite-links-and-group-invitations-phase-5).
// Placeholder: P5-S1 adds the table and implements it (JSDoc in types.ts).

import { KeithError } from '@keith/sdk'
import type { Orm } from './orm.ts'
import type { InviteLinksRepository } from './types.ts'

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `${what} not implemented yet (P5-S1)`)
}

export function createInviteLinksRepository(_db: Orm): InviteLinksRepository {
  return {
    async create() {
      throw notImplemented('inviteLinks.create')
    },
    async get() {
      throw notImplemented('inviteLinks.get')
    },
    async markUsed() {
      throw notImplemented('inviteLinks.markUsed')
    },
    async revokeFor() {
      throw notImplemented('inviteLinks.revokeFor')
    },
  }
}
