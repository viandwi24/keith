// Delivery service of the core (docs/specs/delivery.md): one way to tell a person something, exactly once per run id.
export {
  createDelivery,
  DEFAULT_RETRY_MS,
  DEFAULT_TICK_MS,
  type Delivery,
  type DeliveryActivity,
  type DeliveryOptions,
  type DeliveryRoute,
  outcomeOf,
  type RouteHold,
  type RoutePlan,
  type RoutePlanner,
  type RouteResult,
  requestOf,
  TICK_LIMIT,
} from './delivery.ts'
export {
  createDigest,
  type Digest,
  type DigestOptions,
  digestId,
  digestText,
  HELD_MAX_MS,
} from './digest.ts'
export { singleRoutePlanner } from './planner.ts'
export { deliveryRemoval } from './removal.ts'
export {
  createFrontRoute,
  type FrontRouteOptions,
  INJECT_KEY_MAX,
  injectKey,
  interruptingRoute,
} from './route-front.ts'
