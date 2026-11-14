// The default route of the delivery service: the person's front session (docs/specs/delivery.md, "Default route: front").
// The rules of the wake (budget, then one inject) live here only: `modules/plugins/wake.ts` is an adapter over the service.
import { createHash } from 'node:crypto'
import type { DeliveryRequest } from '@keith/contracts'
import type { HarnessAgent, SessionLock } from 'eharness'
import {
  type FrontGenerationOf,
  frontSessionId,
  frontSessionOptions,
} from '../../platform/sessions.ts'
import { FRONT_TURN_BUDGET_USD } from '../budget/index.ts'
import type { DeliveryRoute, RouteResult } from './delivery.ts'

/** The longest inject key eharness accepts; a longer run id is replaced by its SHA-256 hex. */
export const INJECT_KEY_MAX = 200

/** The idempotency key of the inject for a run id: the id itself, or its SHA-256 hex when it is too long. */
export function injectKey(runId: string): string {
  if (runId.length <= INJECT_KEY_MAX) return runId
  return createHash('sha256').update(runId).digest('hex')
}

export interface FrontRouteOptions {
  /** The front agent (lazy: it is built after the plugin host). */
  lead: () => HarnessAgent | undefined
  lock: SessionLock
  /** What the payer has left for one more turn (`null`: no limit). */
  remainingUsd: (personId: string) => number | null
  warn(message: string): void
  /** The current front generation of each person (ADR-0030 §2): the session the person's events go to. */
  generations: FrontGenerationOf
}

/**
 * The front session of the recipient as a route. A `wake` delivery starts a turn (the person's principal, the payer as
 * `billTo` when it is somebody else); a `note` delivery stores the message with no turn and no budget check.
 */
export function createFrontRoute(options: FrontRouteOptions): DeliveryRoute {
  return {
    id: 'front',
    async send(request: DeliveryRequest): Promise<RouteResult> {
      const payer = request.billTo ?? request.to
      const wake = request.needs.mode === 'wake'
      if (wake) {
        const left = options.remainingUsd(payer)
        if (left !== null && left < FRONT_TURN_BUDGET_USD) return { ok: false, reason: 'budget' }
      }
      const agent = options.lead()
      if (agent === undefined) return { ok: false, reason: 'unavailable' }
      try {
        const id = frontSessionId(request.to, options.generations.current(request.to))
        const session = agent.session(id, frontSessionOptions(id, options.lock))
        const principal =
          payer === request.to ? { id: request.to } : { id: request.to, billTo: payer }
        await session.inject(
          'eh.event',
          { name: request.name, text: request.text, data: request.data },
          { deliver: 'next-turn', wake, principal, key: injectKey(request.id) },
        )
        return { ok: true }
      } catch (error) {
        options.warn(`delivery failed: ${error instanceof Error ? error.message : error}`)
        return { ok: false, reason: 'unavailable' }
      }
    },
  }
}
