// The ports of the parietal region (docs/specs/parietal.md, "Ports"): the only entry points other regions may use.
import type { DisclosureLevel, SignalType } from '@keith/contracts'
import type { PresenceSignalsRepo } from '@keith/db'
import type { OverlayRegistry, PresenceOverlay } from './overlay.ts'

/** The signals `lastSign` counts: a message, a client that was in use, or a client that connected. */
export const LAST_SIGN_TYPES: readonly SignalType[] = [
  'activity',
  'client.active',
  'client.connected',
]

/** What a viewer may read of a subject (`disclosedFor`): nothing, the state, or the state with the note. */
export interface DisclosedLine {
  level: DisclosureLevel
  /** The line the model may say, or null when nothing is released. */
  line: string | null
}

/**
 * The ports other regions consume (P28, P29, P30). `lastSign`, `addOverlay` and `disclosedFor` are final; the rule
 * behind `disclosedFor` is `disclose.ts`.
 */
export interface ParietalPorts {
  /** The newest message, in-use or connect signal of the person, or null (after a sign-in). */
  lastSign(personId: string): Promise<number | null>
  /** What `viewer` may read of `subject`: the released level and its line (never more; docs/specs/parietal.md, "Disclosure"). */
  disclosedFor(viewer: string, subject: string): Promise<DisclosedLine>
  /** Registers an overlay source (a manual status is the first one; P28's agenda registers another). */
  addOverlay(overlay: PresenceOverlay): void
}

export interface ParietalPortsDeps {
  signals: Pick<PresenceSignalsRepo, 'newest'>
  overlays: OverlayRegistry
  disclosure: { disclosedFor(viewer: string, subject: string): Promise<DisclosedLine> }
}

export function createParietalPorts(deps: ParietalPortsDeps): ParietalPorts {
  return {
    async lastSign(personId) {
      return deps.signals.newest(personId, LAST_SIGN_TYPES)
    },
    disclosedFor(viewer, subject) {
      return deps.disclosure.disclosedFor(viewer, subject)
    },
    addOverlay(overlay) {
      deps.overlays.add(overlay)
    },
  }
}
