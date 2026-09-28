// Relays (phase 5): one person's message passed to another through Keith (I-13, ADR-0017).
// See docs/architecture/core.md#relays. Placeholder: P5-B1 implements it.

import { KeithError } from '@keith/sdk'
import type { Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import type { DeliveryQueue, RelayService } from './types.ts'

export type RelayServiceDeps = {
  /** Tiers, block lists (`relationships.blockedRelayFrom`) and the recipient's main thread. */
  repos: Pick<Repositories, 'persons' | 'relationships' | 'threads'>
  /** A relay is a `relay` delivery authored by the sender. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  log: Logger
}

function notImplemented(what: string): KeithError {
  return new KeithError('INTERNAL', `relay.${what} not implemented yet (P5-B1)`)
}

/** Placeholder: every method throws `INTERNAL`. */
export function createRelayService(_deps: RelayServiceDeps): RelayService {
  return {
    async send() {
      throw notImplemented('send')
    },
    async block() {
      throw notImplemented('block')
    },
    async unblock() {
      throw notImplemented('unblock')
    },
  }
}
