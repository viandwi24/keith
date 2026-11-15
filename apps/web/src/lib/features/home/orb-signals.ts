import { type OrbInput, orbModeOf } from '@keith/app-model'
import type { LinkKind } from '@keith/client/browser'
import type { OrbMode } from '@keith/ui/orb'

export interface OrbSignals {
  /** The link monitor's kind. */
  link: LinkKind
  /** Approvals this person can answer. */
  approvals: number
  /** The front turn runs. */
  busy: boolean
  /** The assistant's answer is streaming. */
  speaking: boolean
  /** A draft is waiting in the chat or quick-ask field. */
  typing: boolean
}

/** The TUI's alert (logged out, core unreachable) plus the web's: an approval waits for an answer. */
export const isAlert = (link: LinkKind, approvals: number): boolean =>
  link === 'disconnected' || link === 'logged-out' || approvals > 0

export const orbInputOf = (s: OrbSignals): OrbInput => ({
  alert: isAlert(s.link, s.approvals),
  busy: s.busy,
  speaking: s.speaking,
  typing: s.typing,
})

/** idle, listening, thinking, speaking or alert: the same signals the TUI reads, from real state only. */
export const orbModeFor = (s: OrbSignals): OrbMode => orbModeOf(orbInputOf(s))
