// reminders repository (phase 4, docs/architecture/storage.md).
// Placeholder (P4-K1): task P4-S1 adds the table and implements every member.

import { KeithError } from '@keith/sdk'
import type { Orm } from './orm.ts'
import type { RemindersRepository } from './types.ts'

function notImplemented(member: string): never {
  throw new KeithError('INTERNAL', `reminders.${member} is not implemented yet (P4-S1)`)
}

export function createRemindersRepository(_db: Orm): RemindersRepository {
  return {
    async create() {
      notImplemented('create')
    },
    async get() {
      notImplemented('get')
    },
    async listDue() {
      notImplemented('listDue')
    },
    async listPending() {
      notImplemented('listPending')
    },
    async countPending() {
      notImplemented('countPending')
    },
    async markFired() {
      notImplemented('markFired')
    },
    async cancel() {
      notImplemented('cancel')
    },
  }
}
