import type { ViewEndReason } from '@keith/client'
import type { ColorDepth } from '@keith/ui'

/** What the panel says when a view is over, and whether `r` may open a fresh one. */
export interface EndText {
  rows: readonly string[]
  /** A refused, revoked or over-the-limit view would only be refused again; the rest may be reopened. */
  reopen: boolean
}

/** The panel's words when no answer came in time (the attempt is closed; `r` retries it). */
export const TIMEOUT_TEXT: EndText = {
  rows: ['The view did not answer in 10 seconds.', 'The link to the core may be slow or dropped.'],
  reopen: true,
}

export function endText(reason: ViewEndReason): EndText {
  switch (reason) {
    case 'view':
      return { rows: ['The view ended.'], reopen: true }
    case 'idle':
      return { rows: ['The view closed after 10 minutes without a key.'], reopen: true }
    case 'revoked':
      return {
        rows: [
          'This view is no longer allowed for your session.',
          'Sign in again or ask the owner.',
        ],
        reopen: false,
      }
    case 'limit':
      return {
        rows: ['Too many views are open.', 'Close one (esc) and try again.'],
        reopen: true,
      }
    case 'refused':
      return { rows: ['This view is not available to you.'], reopen: false }
    case 'error':
      return { rows: ['The view stopped because of an error.'], reopen: true }
    case 'disconnected':
      return { rows: ['Disconnected from the core.'], reopen: true }
    case 'unavailable':
      return {
        rows: ['Could not open the view: the core did not answer, or it is locked.'],
        reopen: true,
      }
    case 'protocol':
      return { rows: ['The core sent something this client will not show.'], reopen: true }
  }
}

/** The colour depth a view is asked for (the client quantizes to it): none is 1, the 16 colours 4. */
export const viewDepth = (depth: ColorDepth): 1 | 4 | 8 | 24 =>
  depth === 'truecolor' ? 24 : depth === '256' ? 8 : depth === '16' ? 4 : 1
