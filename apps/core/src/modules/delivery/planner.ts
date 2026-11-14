// The default route planner (docs/specs/delivery.md, "Planner seam"): the person's front session and nothing else.
import type { DeliveryRoute, RoutePlanner } from './delivery.ts'

/** A planner that offers one route for every person. P27 replaces it with a presence-ordered planner. */
export function singleRoutePlanner(route: DeliveryRoute): RoutePlanner {
  return { plan: async () => [route] }
}
