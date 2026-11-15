import type { DeliveryOutcome } from '@keith/contracts'
import type { WakePort, WakeRequest, WakeResult } from '@keith/host'
import type { Delivery } from '../delivery/index.ts'

export interface WakeOptions {
  /** The core's delivery service: every plugin wake goes through it (docs/specs/delivery.md). */
  delivery: Delivery
}

/**
 * The plugin-facing wake (docs/specs/plugins.md, "Schedules and wake"): an adapter over the delivery service. A wake is a
 * `wake` delivery from `plugin:<id>` to the recipient's front session: the turn acts as the recipient, `billTo` moves only
 * the cost, the run id `request.id` makes it exactly once, and a front agent that is briefly unreachable queues the
 * message for a retry instead of failing it. The recipient check, the budget and the failure notice are the service's.
 */
export function createWake(options: WakeOptions): WakePort {
  return {
    async deliver(pluginId, request) {
      const outcome = await options.delivery.deliver(requestFor(pluginId, request))
      return resultOf(outcome)
    },
  }
}

/** The delivery request a plugin wake stands for (`needs` default: a turn). */
function requestFor(pluginId: string, request: WakeRequest) {
  return {
    id: request.id,
    source: `plugin:${pluginId}`,
    to: request.to,
    ...(request.billTo === undefined ? {} : { billTo: request.billTo }),
    name: request.name,
    text: request.text,
    ...(request.data === undefined ? {} : { data: request.data }),
    ...(request.immediate === true
      ? {
          needs: {
            mode: 'wake' as const,
            capabilities: [],
            fanout: 'best' as const,
            urgency: 'normal' as const,
            immediate: true,
          },
        }
      : {}),
    ...(request.failureNotice === undefined ? {} : { onFailure: request.failureNotice }),
  }
}

/** The plugin's answer for a stored outcome: a queued wake counts as delivered (it is kept until it is). */
export function resultOf(outcome: DeliveryOutcome): WakeResult {
  switch (outcome.status) {
    case 'delivered':
      return { delivered: true }
    case 'queued':
      return { delivered: true, queued: { nextAttemptAt: outcome.nextAttemptAt } }
    case 'held':
      // kept for the return digest: it counts as delivered; `nextAttemptAt` is the end of the status (0: when the person returns)
      return { delivered: true, queued: { nextAttemptAt: outcome.until ?? 0 } }
    case 'failed':
      // `no-route` is the core giving up on a route it does not have, so it is reported as `unavailable`
      return {
        delivered: false,
        reason: outcome.reason === 'no-route' ? 'unavailable' : outcome.reason,
      }
  }
}
