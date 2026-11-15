// The core's delivery service, wired (docs/specs/delivery.md, "Service" and "Timer"): the `deliveries` table, the front route, the
// person check, the activity record of a failure, and the retry tick. compose.ts builds it once; the plugins wake through it.
import { deliveriesRepo } from '@keith/db'
import type { HarnessAgent, SessionLock } from 'eharness'
import type { createIdentity } from './compose-identity.ts'
import type { CoreTiming } from './compose-timers.ts'
import { emit } from './modules/brain-events/index.ts'
import { createDelivery, createFrontRoute, type Delivery } from './modules/delivery/index.ts'
import { createPresenceFeed } from './modules/delivery/presence-feed.ts'
import { createPresencePlanner, type ParietalService } from './modules/parietal/index.ts'
import type { PushService } from './modules/push/index.ts'
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
  /** Web Push (docs/specs/push.md): the person's push route, asked by the planner when the reach ladder says so. */
  push?: Pick<PushService, 'hasSubscriptions' | 'route'>
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
  // one notice to the active client that takes `notify` when a digest is released (best effort)
  const notify = async (personId: string, text: string): Promise<void> => {
    const activeId = deps.parietal.presence(personId).activeClient
    const client = deps.parietal
      .list(personId)
      .find((c) => c.id === activeId && c.online && c.capabilities.includes('notify'))
    if (client === undefined) return
    await deps.parietal.callClient(
      personId,
      'notify',
      { text },
      { clientId: client.id, deliveryId: `digest-notice:${Date.now()}`, name: 'digest' },
    )
  }
  const delivery = createDelivery({
    front: route,
    notify,
    presenceOf: (personId) => deps.parietal.presence(personId),
    generations: deps.generations,
    deliveries: deliveriesRepo(deps.sqlite),
    planner: createPresencePlanner({
      parietal: deps.parietal,
      front: route,
      ...(deps.push === undefined
        ? {}
        : {
            push: (personId) =>
              deps.push?.hasSubscriptions(personId) === true ? [deps.push.route(personId)] : [],
          }),
    }),
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
  // the return digest: a presence record that says the person is back releases what was held (docs/specs/delivery.md)
  const feed = createPresenceFeed({
    feed: {
      read: async (query) =>
        (await deps.store.read({ after: query.after, limit: query.limit, types: query.types })).map(
          (r) => ({ seq: r.seq, payload: r.payload }),
        ),
      lastSeq: () => deps.store.lastSeq(),
    },
    onBack: (personId) => delivery.release(personId),
    everyMs: Math.min(deps.timing.deliveryTickMs, 5_000),
    warn,
  })
  return {
    ...delivery,
    start() {
      delivery.start()
      feed.start()
    },
    stop() {
      feed.stop()
      delivery.stop()
    },
  }
}
