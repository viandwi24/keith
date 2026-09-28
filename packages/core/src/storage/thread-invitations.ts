// thread_invitations repository (phase 5, docs/architecture/storage.md#invite-links-and-group-invitations-phase-5).
// Placeholder: P5-S1 adds the table and implements it (JSDoc in types.ts).

import { KeithError } from '@keith/sdk'
import type { Orm } from './orm.ts'
import type { ThreadInvitationsRepository } from './types.ts'

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `${what} not implemented yet (P5-S1)`)
}

export function createThreadInvitationsRepository(_db: Orm): ThreadInvitationsRepository {
  return {
    async create() {
      throw notImplemented('threadInvitations.create')
    },
    async get() {
      throw notImplemented('threadInvitations.get')
    },
    async pendingForThread() {
      throw notImplemented('threadInvitations.pendingForThread')
    },
    async pendingForPerson() {
      throw notImplemented('threadInvitations.pendingForPerson')
    },
    async resolve() {
      throw notImplemented('threadInvitations.resolve')
    },
  }
}
