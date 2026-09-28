// Group threads (phase 5): start, invite, join and leave, with invitations as deliveries.
// See docs/architecture/core.md#group-threads and ADR-0017. Placeholder: P5-C1 implements it.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { DeliveryQueue } from '../scheduler/types.ts'
import type { Clock, Ids, Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { GroupThreads } from './types.ts'

export type GroupThreadsDeps = {
  /** `mind.group` (`maxParticipants`, `autoJoin`). */
  config: Pick<KeithConfig, 'mind'>
  repos: Pick<Repositories, 'persons' | 'threads' | 'threadInvitations'>
  /** Invitations are `invitation` deliveries in the invitee's main thread. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  /** Emits `thread.participant_joined` and `thread.participant_left`. */
  events: Pick<CoreEventBus, 'emit'>
  ids: Ids
  clock: Clock
  log: Logger
}

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `groups.${what} not implemented yet (P5-C1)`)
}

/** Placeholder: every method throws `INTERNAL`. */
export function createGroupThreads(_deps: GroupThreadsDeps): GroupThreads {
  return {
    async start() {
      throw notImplemented('start')
    },
    async invite() {
      throw notImplemented('invite')
    },
    async join() {
      throw notImplemented('join')
    },
    async leave() {
      throw notImplemented('leave')
    },
  }
}
