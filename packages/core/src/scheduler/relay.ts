// Relays (phase 5): one person's message passed to another through Keith (I-13, ADR-0017).
// See docs/architecture/core.md#relays.

import type { Logger, PersonId } from '../shared/types.ts'
import type { RelationshipRecord, Repositories } from '../storage/types.ts'
import { MAIN_THREAD_SLUG } from './deliveries.ts'
import type { DeliveryQueue, RelayService } from './types.ts'

export type RelayServiceDeps = {
  /** Tiers, block lists (`relationships.blockedRelayFrom`) and the recipient's main thread. */
  repos: Pick<Repositories, 'persons' | 'relationships' | 'threads'>
  /** A relay is a `relay` delivery authored by the sender. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  log: Logger
}

/**
 * Decides relays (I-13, ADR-0017) and enqueues them as `relay` deliveries in the recipient's
 * main thread. Checks, in order: `self`, `unknown_recipient`, then `not_allowed` (a guest may
 * relay only to the owner; the recipient's block wins over every tier). Writes no memory.
 */
export function createRelayService(deps: RelayServiceDeps): RelayService {
  const { repos, deliveries } = deps
  const log = deps.log.child({ component: 'relay' })

  async function cardOf(personId: PersonId): Promise<RelationshipRecord> {
    return (
      (await repos.relationships.get(personId)) ?? { personId, tone: '', notes: '', blockedRelayFrom: [] }
    )
  }

  async function changeBlock(personId: PersonId, from: PersonId, blocked: boolean): Promise<boolean> {
    // Nobody blocks themselves; there is nothing to change.
    if (personId === from) return false
    const card = await cardOf(personId)
    const has = card.blockedRelayFrom.includes(from)
    if (has === blocked) return false
    const blockedRelayFrom = blocked
      ? [...card.blockedRelayFrom, from]
      : card.blockedRelayFrom.filter((id) => id !== from)
    await repos.relationships.upsert({ ...card, blockedRelayFrom })
    log.info(blocked ? 'relay blocked' : 'relay unblocked', { personId, from })
    return true
  }

  return {
    async send({ fromPersonId, toPersonId, text }) {
      if (fromPersonId === toPersonId) return { ok: false, reason: 'self' }

      const recipient = await repos.persons.get(toPersonId)
      const main = recipient ? await repos.threads.getBySlug(toPersonId, MAIN_THREAD_SLUG) : null
      if (!recipient || !main) return { ok: false, reason: 'unknown_recipient' }

      const sender = await repos.persons.get(fromPersonId)
      if (!sender) {
        log.warn('relay refused: unknown sender', { from: fromPersonId, to: toPersonId })
        return { ok: false, reason: 'not_allowed' }
      }
      if (sender.tier === 'guest' && recipient.tier !== 'owner') {
        log.info('relay refused', { from: fromPersonId, to: toPersonId, rule: 'tier' })
        return { ok: false, reason: 'not_allowed' }
      }
      const card = await repos.relationships.get(toPersonId)
      if (card?.blockedRelayFrom.includes(fromPersonId)) {
        log.info('relay refused', { from: fromPersonId, to: toPersonId, rule: 'block' })
        return { ok: false, reason: 'not_allowed' }
      }

      const delivery = await deliveries.enqueue({
        personId: toPersonId,
        threadId: main.id,
        kind: 'relay',
        authorPersonId: fromPersonId,
        source: 'core',
        urgency: 'normal',
        content: text,
      })
      // The text stays out of the log: it is the sender's private message.
      log.info('relay sent', { from: fromPersonId, to: toPersonId, deliveryId: delivery.id })
      return { ok: true, delivery }
    },
    block({ personId, from }) {
      return changeBlock(personId, from, true)
    },
    unblock({ personId, from }) {
      return changeBlock(personId, from, false)
    },
  }
}
