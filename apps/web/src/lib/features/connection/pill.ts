import type { LinkState } from '@keith/client/browser'
import { G } from '@keith/ui/tokens'

export type Tone = 'muted' | 'success' | 'warning' | 'danger'

export interface Pill {
  glyph: string
  label: string
  tone: Tone
}

/** The connection pill of the top bar for the link monitor's state (the TUI's `✳ online` / `✳ logged out` line, in words). */
export function pillOf(link: LinkState): Pill {
  switch (link.kind) {
    case 'connecting':
      return { glyph: G.working, label: 'connecting', tone: 'muted' }
    case 'live':
      return { glyph: G.dot, label: 'live', tone: 'success' }
    case 'reconnecting':
      return { glyph: G.working, label: 'reconnecting', tone: 'warning' }
    case 'disconnected':
      return { glyph: G.failed, label: 'offline', tone: 'danger' }
    case 'logged-out':
      return { glyph: G.warn, label: 'logged out', tone: 'danger' }
  }
}

/** The offline banner shows while the core cannot be reached, after a drop (`disconnected` or `reconnecting`). */
export const isOffline = (link: LinkState): boolean =>
  link.kind === 'disconnected' || link.kind === 'reconnecting'

/** `cannot reach the core (connection refused)`: what could not be reached and the last error (the TUI's words). */
export function offlineText(link: Pick<LinkState, 'reason'>): string {
  const reason = link.reason === undefined || link.reason === '' ? '' : ` (${link.reason})`
  return `cannot reach the core${reason}`
}

/** `retrying in 12 s` while disconnected, `retrying now` for a reconnect window, else nothing. */
export function retryText(link: LinkState, now: number): string {
  if (link.kind === 'reconnecting') return 'retrying now'
  if (link.kind !== 'disconnected' || link.retryAt === undefined) return ''
  const s = Math.max(0, Math.ceil((link.retryAt - now) / 1000))
  return s === 0 ? 'retrying now' : `retrying in ${s} s`
}
