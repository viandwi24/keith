// Presence and arrival per Person. See docs/architecture/core.md#presence-and-arrival.
//
// A Person is present while at least one of their attended nodes has a Thread open. The server
// reports node attach/detach here; this module decides arrival, keeps `persons.last_seen_at`
// current, and emits `person.arrived` / `person.left`.

import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { Arrival } from '../mind/types.ts'
import type { Clock, Logger, NodeId, PersonId } from '../shared/types.ts'
import type { PersonsRepository } from '../storage/types.ts'
import type { Presence } from './types.ts'

/** Presence plus the hooks only the server calls. */
export interface ServerPresence extends Presence {
  /** Seeds the in-memory `lastSeenAt` from a loaded person record (no-op once known). */
  remember(personId: PersonId, lastSeenAt: number | null): void
  /**
   * What an attach by this person would mean right now: null when they are already present,
   * otherwise the arrival (threshold reached, or first-ever attach) or null (quick reconnect).
   * Loads `last_seen_at` from storage if it is not cached yet.
   */
  arrivalFor(personId: PersonId): Promise<Arrival | null>
  /** A node of the person now has at least one thread open. */
  nodeAttached(personId: PersonId, nodeId: NodeId): void
  /** The node has no thread open any more. The last one makes the person away. */
  nodeDetached(personId: PersonId, nodeId: NodeId): Promise<void>
  /** Emits `person.arrived`. Called by the server once `ThreadManager.open` succeeded. */
  announceArrival(personId: PersonId, arrival: Arrival): void
  /** Unsubscribes from `scheduler.ticked`. */
  dispose(): void
}

export type PresenceDeps = {
  config: Pick<KeithConfig, 'mind'>
  clock: Clock
  log: Logger
  events: CoreEventBus
  persons: Pick<PersonsRepository, 'get' | 'setLastSeenAt'>
}

export function createPresence(deps: PresenceDeps): ServerPresence {
  const log = deps.log.child({ component: 'presence' })
  const present = new Map<PersonId, Set<NodeId>>()
  const lastSeen = new Map<PersonId, number | null>()
  const thresholdMs = deps.config.mind.arrival.awayAfterMinutes * 60_000

  const write = async (ids: PersonId[], at: number) => {
    if (ids.length === 0) return
    for (const id of ids) lastSeen.set(id, at)
    await deps.persons.setLastSeenAt(ids, at)
  }

  const unsubscribe = deps.events.on('scheduler.ticked', async (e) => {
    try {
      await write([...present.keys()], e.data.at)
    } catch (error) {
      log.error('last seen refresh failed', { error: String(error) })
    }
  })

  return {
    isPresent: (personId) => (present.get(personId)?.size ?? 0) > 0,
    lastSeenAt: (personId) => lastSeen.get(personId) ?? null,
    async flushPresence() {
      await write([...present.keys()], deps.clock.now())
    },
    remember(personId, at) {
      if (!lastSeen.has(personId)) lastSeen.set(personId, at)
    },
    async arrivalFor(personId) {
      if ((present.get(personId)?.size ?? 0) > 0) return null
      if (!lastSeen.has(personId)) {
        const record = await deps.persons.get(personId)
        lastSeen.set(personId, record?.lastSeenAt ?? null)
      }
      const at = lastSeen.get(personId) ?? null
      if (at === null) return { awayMs: null }
      const awayMs = Math.max(0, deps.clock.now() - at)
      return awayMs >= thresholdMs ? { awayMs } : null
    },
    nodeAttached(personId, nodeId) {
      const nodes = present.get(personId) ?? new Set<NodeId>()
      nodes.add(nodeId)
      present.set(personId, nodes)
    },
    async nodeDetached(personId, nodeId) {
      const nodes = present.get(personId)
      if (!nodes?.delete(nodeId)) return
      if (nodes.size > 0) return
      present.delete(personId)
      await write([personId], deps.clock.now())
      deps.events.emit('person.left', { personId })
    },
    announceArrival(personId, arrival) {
      deps.events.emit('person.arrived', { personId, awayMs: arrival.awayMs })
    },
    dispose: unsubscribe,
  }
}
