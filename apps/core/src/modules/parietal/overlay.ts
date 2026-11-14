// Overlays: sources that make a person busy whatever their clients say (docs/specs/parietal.md, "Ports"). The manual
// status is the first source; a source registered later (P28's agenda) comes after it. Presence reads the first that
// holds; a source never reads presence back.
import type { BusyOverlay } from './compute.ts'

export interface PresenceOverlay {
  /** Unique id of the source, for the errors and the tests. */
  id: string
  /** Busy with a note and an end when the source holds for the person at `now`; undefined otherwise. */
  busy(personId: string, now: number): BusyOverlay | undefined
}

export interface OverlayRegistry {
  /** Adds a source after the ones already registered. A second source with the same id is refused. */
  add(overlay: PresenceOverlay): void
  /** The first busy answer of the sources, in registration order; undefined when none holds. */
  busyOf(personId: string, now: number): BusyOverlay | undefined
}

export function createOverlayRegistry(): OverlayRegistry {
  const list: PresenceOverlay[] = []
  return {
    add(overlay) {
      if (list.some((o) => o.id === overlay.id))
        throw new Error(`presence overlay ${overlay.id} is registered twice`)
      list.push(overlay)
    },
    busyOf(personId, now) {
      for (const overlay of list) {
        const busy = overlay.busy(personId, now)
        if (busy !== undefined) return busy
      }
      return undefined
    },
  }
}
