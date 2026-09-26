// Commitments: promises made in a thread, linked to a task (I-10). See
// docs/architecture/core.md#commitments.

import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { Clock, Commitment, Ids, Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { CommitmentService } from './types.ts'

export type CommitmentManager = CommitmentService & {
  /** Expires every open commitment whose `expiresAt` has passed. Runs on each `scheduler.ticked`. */
  expireDue(): Promise<Commitment[]>
}

export type CommitmentServiceDeps = {
  config: { mind: Pick<KeithConfig['mind'], 'commitment'> }
  repos: Pick<Repositories, 'commitments'>
  events: CoreEventBus
  ids: Ids
  clock: Clock
  log: Logger
}

export function createCommitmentService(deps: CommitmentServiceDeps): CommitmentManager {
  const { config, repos, events, ids, clock, log } = deps
  return {
    async create(c) {
      const now = clock.now()
      const commitment: Commitment = {
        id: ids.next('cmt'),
        threadId: c.threadId,
        personId: c.personId,
        taskId: c.taskId,
        promise: c.promise,
        status: 'open',
        createdAt: now,
        resolvedAt: null,
        expiresAt: now + config.mind.commitment.ttlMs,
      }
      await repos.commitments.create(commitment)
      events.emit('commitment.created', {
        commitmentId: commitment.id,
        threadId: commitment.threadId,
        taskId: commitment.taskId,
      })
      return commitment
    },
    async resolveForTask(taskId, outcome) {
      const open = await repos.commitments.openForTask(taskId)
      if (!open) return null
      const resolvedAt = clock.now()
      await repos.commitments.resolve(open.id, outcome, resolvedAt)
      events.emit('commitment.resolved', { commitmentId: open.id, status: outcome })
      return { ...open, status: outcome, resolvedAt }
    },
    openFor(threadId) {
      return repos.commitments.openForThread(threadId)
    },
    async expireDue() {
      const now = clock.now()
      const due = await repos.commitments.listExpired(now)
      const expired: Commitment[] = []
      for (const c of due) {
        await repos.commitments.resolve(c.id, 'expired', now)
        events.emit('commitment.resolved', { commitmentId: c.id, status: 'expired' })
        log.info('commitment expired', { commitmentId: c.id, taskId: c.taskId })
        expired.push({ ...c, status: 'expired', resolvedAt: now })
      }
      return expired
    },
  }
}
