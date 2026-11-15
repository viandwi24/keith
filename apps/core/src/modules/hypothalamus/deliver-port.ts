// The ports of the side-effecting steps (docs/specs/hypothalamus.md, "Engine" and "Principal and rights"): the delivery
// service of P25 (delivery.md), the person check (ADR-0027 §15) and the budget read. Adapters over the owning regions; this
// file only states their shape and maps a delivery outcome to a step outcome.
import type { DeliveryOutcome, DeliveryRequestInput } from '@keith/contracts'

/** The delivery service: exactly once by the request's id (the run id, `<runId>:<stepId>:<visit>` for a step). */
export interface ProtocolDelivery {
  deliver(request: DeliveryRequestInput): Promise<DeliveryOutcome>
}

/** Whether a person counts for routing now: `active` only (ADR-0027 §15, the rule of `platform/sessions.ts`). */
export interface PersonActivity {
  isActive(personId: string): Promise<boolean>
}

/**
 * The step outcome of a delivery outcome: `ok` when delivered, queued for a retry or held for the return digest; `refused:budget` and
 * `refused:person-inactive` for the two terminal refusals; `failed:<reason>` for the rest.
 */
export function outcomeOfDelivery(outcome: DeliveryOutcome): string {
  if (outcome.status === 'delivered' || outcome.status === 'queued' || outcome.status === 'held')
    return 'ok'
  if (outcome.reason === 'budget') return 'refused:budget'
  if (outcome.reason === 'recipient-gone') return 'refused:person-inactive'
  return `failed:${outcome.reason}`
}
