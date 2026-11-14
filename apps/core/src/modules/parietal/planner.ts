// The presence planner (docs/specs/delivery.md, "Planner seam"; docs/specs/parietal.md, "Routing"): P25's `RoutePlanner` with
// presence. A delivery that needs client capabilities tries the person's clients first (the active one, then the reachable
// ones by last activity), each only when it announces every capability asked for; the front session is always last.
import type { DeliveryNeeds, DeliveryRequest } from '@keith/contracts'
import type { DeliveryRoute, RoutePlanner } from '../delivery/index.ts'
import { CLIENT_CAPABILITIES, deliveryInput, isClientCapabilityId } from './capabilities.ts'
import type { ParietalService } from './service.ts'

export interface PresencePlannerDeps {
  parietal: Pick<ParietalService, 'list' | 'presence' | 'callClient'>
  /** The person's front session (P25's `createFrontRoute`): the last route of every plan. */
  front: DeliveryRoute
  /** Push routes (none yet: web and mobile clients are later plans); tried after the clients, before the front session. */
  push?: readonly DeliveryRoute[]
}

/** A route to one client: it does what the delivery's capabilities ask, and is unavailable when the client does not ack. */
function clientRoute(
  parietal: PresencePlannerDeps['parietal'],
  personId: string,
  clientId: string,
  needs: DeliveryNeeds,
): DeliveryRoute {
  return {
    id: `client:${clientId}`,
    async send(request: DeliveryRequest) {
      for (const capability of needs.capabilities) {
        if (!isClientCapabilityId(capability)) return { ok: false, reason: 'unavailable' }
        const input = deliveryInput(capability, request)
        if (input === undefined) return { ok: false, reason: 'unavailable' }
        const call = await parietal.callClient(personId, capability, input, {
          clientId,
          deliveryId: request.id,
          name: request.name,
        })
        if (!call.ok) return { ok: false, reason: 'unavailable' }
      }
      return { ok: true }
    },
  }
}

export function createPresencePlanner(deps: PresencePlannerDeps): RoutePlanner {
  const { parietal, front } = deps
  const push = deps.push ?? []
  return {
    async plan(person, needs) {
      // a plain wake needs no client: the front session is the route (a turn shows on every client of the session)
      if (needs.capabilities.length === 0) return [front]
      // a capability no delivery can carry, or no client of the core knows, leaves the front session alone
      const deliverable = needs.capabilities.every(
        (capability) =>
          isClientCapabilityId(capability) && CLIENT_CAPABILITIES[capability].deliverable,
      )
      if (!deliverable) return [...push, front]

      const clients = parietal
        .list(person)
        .filter((c) => c.online && needs.capabilities.every((cap) => c.capabilities.includes(cap)))
      const activeId = parietal.presence(person).activeClient
      const byActivity = [...clients].sort(
        (a, b) =>
          (b.lastActiveAt ?? Number.NEGATIVE_INFINITY) -
          (a.lastActiveAt ?? Number.NEGATIVE_INFINITY),
      )
      const ordered = [
        ...byActivity.filter((c) => c.id === activeId),
        ...byActivity.filter((c) => c.id !== activeId),
      ]
      const routes = ordered.map((c) => clientRoute(parietal, person, c.id, needs))
      return [...routes, ...push, front]
    },
  }
}
