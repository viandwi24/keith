// The sign of life of a person for the protocols (docs/specs/succession.md, "Sign of life"; docs/specs/parietal.md, "Ports").
// It adds no tracker of its own: the newest sign is parietal's `lastSign` (the signals `activity`, `client.active` and
// `client.connected` of the person), and the one rule added here is the pause: a pause counts as a sign until it ends, so
// the silence is counted from its end. The pause is read through a port (the succession setting, P29.2.6), and the owner
// check lives in that port, so this file never reads a setting.
import type { ParietalPorts } from '../parietal/index.ts'

/**
 * The signals that count as a sign (the list of parietal's `LAST_SIGN_TYPES`, pinned by `sign-of-life.test.ts`). Never
 * `node.event`, a heartbeat without `active`, `client.disconnected`, `device.location` until a client sends it, or any
 * signal of another person. An offline command writes no signal at all (it is the host's break-glass, ADR-0022 §4).
 */
export const SIGN_OF_LIFE_SIGNALS = ['activity', 'client.active', 'client.connected'] as const

export interface SignOfLifeDeps {
  /** Parietal's `lastSign` port: the newest counted signal of the person, or null. */
  lastSign: ParietalPorts['lastSign']
  /**
   * The pause of a person in epoch ms, or null when none is set. Only the owner has one (`succession.pausedUntil`); the
   * port answers null for everybody else. Read at each use, so a change applies at the next read.
   */
  pausedUntil(personId: string): Promise<number | null>
}

/**
 * The sign of life as a port with the shape of the conditions' `lastSign` and the triggers' `LastSignPort`, so the
 * absence trigger and `signal.sinceRunStart` read a pause the same way they read a sign.
 */
export interface SignOfLife {
  /** The newest sign of life of the person: the later of parietal's sign and the pause, or null when neither exists. */
  lastSign(personId: string): Promise<number | null>
}

export function createSignOfLife(deps: SignOfLifeDeps): SignOfLife {
  return {
    async lastSign(personId) {
      const [sign, paused] = await Promise.all([
        deps.lastSign(personId),
        deps.pausedUntil(personId),
      ])
      if (paused === null) return sign
      // a pause that ended long ago does not lower a newer sign, and a pause with no sign is the sign
      return sign === null ? paused : Math.max(sign, paused)
    },
  }
}
