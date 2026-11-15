// The presence planner (docs/specs/delivery.md, "Planner seam"; docs/specs/parietal.md, "Routing"): P25's `RoutePlanner` with
// presence. A delivery that needs client capabilities tries the person's clients first (the active one, then the reachable
// ones by last activity), each only when it announces every capability asked for; the front session is always last.
import type {
  DeliveryHoldReason,
  DeliveryNeeds,
  DeliveryRequest,
  Presence,
  PresenceState,
  PresenceWhere,
} from '@keith/contracts'
import { type DeliveryRoute, interruptingRoute, type RoutePlanner } from '../delivery/index.ts'
import { CLIENT_CAPABILITIES, deliveryInput, isClientCapabilityId } from './capabilities.ts'
import type { ParietalService } from './service.ts'

export interface PresencePlannerDeps {
  parietal: Pick<ParietalService, 'list' | 'presence' | 'callClient'>
  /** The person's front session (P25's `createFrontRoute`): the last route of every plan. */
  front: DeliveryRoute
  /**
   * The push routes of one person (Web Push, docs/specs/push.md): none when the person has no subscription. Asked only when
   * the plan reaches the person away from the desk or urgently (`pushWanted`); tried after the clients, before the front
   * session. A push route is a companion (`DeliveryRoute.companion`): it never replaces the front session.
   */
  push?: (person: string, needs: DeliveryNeeds) => readonly DeliveryRoute[]
}

/**
 * Whether a push goes out with this delivery (ADR-0034 §6, docs/specs/parietal.md "Routing"): an urgent delivery always (the
 * urgent bypass); a note never (it is stored quietly); any other when the person is away or offline, or their `where` is
 * `mobile` or `out` (not at a desk). A person at a desk (`active` or `idle`, `where` `desk` or `unknown`) is reached by the
 * clients and the front session.
 */
export function pushWanted(
  presence: Pick<Presence, 'state' | 'where'>,
  needs: DeliveryNeeds,
): boolean {
  if (needs.urgency === 'high') return true
  if (needs.mode === 'note') return false
  return (
    presence.state === 'away' ||
    presence.state === 'offline' ||
    presence.where === 'mobile' ||
    presence.where === 'out'
  )
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

/** What the person is, for the hold reason and the interrupt line: `out` is a stated status, shown as `away` by the state. */
function holdReasonOf(state: PresenceState, where: PresenceWhere | undefined): DeliveryHoldReason {
  if (state === 'busy') return 'busy'
  if (state === 'offline') return 'offline'
  return where === 'out' ? 'out' : 'away'
}

/**
 * The reach ladder (ADR-0034 §6, docs/specs/parietal.md "Routing"), by state and urgency (`needs.urgency: 'high'` is urgent):
 * active or idle: the routes below; busy, away, out or offline: a normal turn is held (`hold`) for the busy end or the return
 * digest, an urgent one gets the routes below at once and the front session tells the agent to say why it interrupts. A
 * delivery that is a note (no turn) is never held: it is stored quietly.
 */
export function createPresencePlanner(deps: PresencePlannerDeps): RoutePlanner {
  const { parietal } = deps
  return {
    async plan(person, needs) {
      const presence = parietal.presence(person)
      const held = ['busy', 'away', 'offline'].includes(presence.state)
      if (!held) return routesFor(deps, person, needs, deps.front)
      const reason = holdReasonOf(presence.state, presence.where)
      if (needs.urgency !== 'high') {
        if (needs.mode !== 'wake' || needs.immediate)
          return routesFor(deps, person, needs, deps.front)
        return {
          hold: { reason, ...(presence.until === undefined ? {} : { until: presence.until }) },
        }
      }
      return routesFor(deps, person, needs, interruptingRoute(deps.front, reason))
    },
  }
}

/** The routes of a person who can be reached now: clients that announce the capabilities, push routes, then `front`. */
function routesFor(
  deps: PresencePlannerDeps,
  person: string,
  needs: DeliveryNeeds,
  front: DeliveryRoute,
): DeliveryRoute[] {
  const { parietal } = deps
  const presence = parietal.presence(person)
  const push =
    deps.push !== undefined && pushWanted(presence, needs) ? deps.push(person, needs) : []
  // a plain wake needs no client: the front session is the route (a turn shows on every client of the session)
  if (needs.capabilities.length === 0) return [...push, front]
  // a capability no delivery can carry, or no client of the core knows, leaves the front session alone
  const deliverable = needs.capabilities.every(
    (capability) => isClientCapabilityId(capability) && CLIENT_CAPABILITIES[capability].deliverable,
  )
  if (!deliverable) return [...push, front]

  const clients = parietal
    .list(person)
    .filter((c) => c.online && needs.capabilities.every((cap) => c.capabilities.includes(cap)))
  const activeId = presence.activeClient
  const byActivity = [...clients].sort(
    (a, b) =>
      (b.lastActiveAt ?? Number.NEGATIVE_INFINITY) - (a.lastActiveAt ?? Number.NEGATIVE_INFINITY),
  )
  const ordered = [
    ...byActivity.filter((c) => c.id === activeId),
    ...byActivity.filter((c) => c.id !== activeId),
  ]
  const routes = ordered.map((c) => clientRoute(parietal, person, c.id, needs))
  return [...routes, ...push, front]
}
