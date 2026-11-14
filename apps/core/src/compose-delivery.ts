// The core's delivery service, wired (docs/specs/delivery.md, "Service" and "Timer"): the `deliveries` table, the front route, the
// person check, the activity record of a failure, and the retry tick. compose.ts builds it once; the plugins wake through it.
import { deliveriesRepo } from '@keith/db'
import type { HarnessAgent, SessionLock } from 'eharness'
import type { createIdentity } from './compose-identity.ts'
import type { CoreTiming } from './compose-timers.ts'
import { emit } from './modules/brain-events/index.ts'
import { createDelivery, createFrontRoute, type Delivery } from './modules/delivery/index.ts'
import { createPresencePlanner, type ParietalService } from './modules/parietal/index.ts'
import type { Logger } from './platform/logger.ts'
import { countsFor, type FrontGenerationOf } from './platform/sessions.ts'

type Identity = ReturnType<typeof createIdentity>

export interface DeliveryDeps {
  /** The current front generation of each person (ADR-0030 §2): the session of every front call. */
  generations: FrontGenerationOf
  sqlite: Parameters<typeof deliveriesRepo>[0]
  logger: Logger
  /** The people directory: the recipient must count for routing now (ADR-0027 §15). */
  people: Pick<Identity['people'], 'get'>
  /** The audit log (`delivery.*` kinds, never text). */
  audit: Identity['audit']
  /** The activity store: a failure is written on the recipient's front session (no text). */
  store: Parameters<typeof emit>[0]
  /** What the payer has left for one more turn (`null`: no limit). */
  remainingUsd: (personId: string) => number | null
  /** The front agent, once it is wired (the route is lazy). */
  lead: () => HarnessAgent | undefined
  lock: SessionLock
  timing: Pick<CoreTiming, 'deliveryTickMs' | 'deliveryRetryMs'>
  /** The parietal region: its clients route a delivery that needs a capability (docs/specs/parietal.md, "Routing"). */
  parietal: Pick<ParietalService, 'list' | 'presence' | 'callClient'>
}

/** The delivery service with its one default route (the front session) and the boot timer left to the caller (`start`). */
export function createDeliveryService(deps: DeliveryDeps): Delivery {
  const warn = (message: string) => deps.logger.warn(message)
  const route = createFrontRoute({
    generations: deps.generations,
    lead: deps.lead,
    lock: deps.lock,
    remainingUsd: deps.remainingUsd,
    warn,
  })
  return createDelivery({
    generations: deps.generations,
    deliveries: deliveriesRepo(deps.sqlite),
    planner: createPresencePlanner({ parietal: deps.parietal, front: route }),
    audit: deps.audit,
    activity: {
      record: (sessionId, type, payload) => emit(deps.store, type, sessionId, null, payload, warn),
    },
    isActive: async (personId) => {
      const person = await deps.people.get(personId).catch(() => undefined)
      return person !== undefined && countsFor('route', person.status)
    },
    now: () => Date.now(),
    retryMs: deps.timing.deliveryRetryMs,
    tickMs: deps.timing.deliveryTickMs,
    warn,
  })
}
