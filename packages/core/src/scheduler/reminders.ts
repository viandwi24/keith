// Reminders (phase 4): stored by `reminder.set`, fired as `reminder` deliveries on scheduler ticks.
// See docs/architecture/core.md#reminders.
// Placeholder (P4-K1): `fireDue` fires nothing and the other members throw. Task P4-C1 implements it.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { Clock, Ids, Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { DeliveryQueue, ReminderService } from './types.ts'

export type ReminderServiceDeps = {
  /** `mind.reminder.maxPerPerson`. */
  config: Pick<KeithConfig, 'mind'>
  repos: Pick<Repositories, 'reminders'>
  /** Fired reminders are enqueued here as `kind: 'reminder'`. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  ids: Ids
  clock: Clock
  log: Logger
}

function notImplemented(member: string): never {
  throw new KeithError('INTERNAL', `reminders.${member} is not implemented yet (P4-C1)`)
}

export function createReminderService(_deps: ReminderServiceDeps): ReminderService {
  return {
    async set() {
      notImplemented('set')
    },
    async cancel() {
      notImplemented('cancel')
    },
    async listFor() {
      notImplemented('listFor')
    },
    async fireDue() {
      return 0
    },
  }
}
