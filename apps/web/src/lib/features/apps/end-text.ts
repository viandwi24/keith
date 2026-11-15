// What the page says when a view is over, and whether "Open again" may be offered (docs/specs/plugin-views.md, "Web"). The TUI's words.
import type { ViewEndReason } from '@keith/client/browser'

export interface EndText {
  rows: readonly string[]
  /** A refused, revoked or over-the-limit view would only be refused again; the rest may be reopened. */
  reopen: boolean
  /** Whether it is worth a warning tone (a view that finished by itself is not). */
  warning: boolean
}

/** After this long without a `ready` the attempt is given up. */
export const PENDING_TIMEOUT_MS = 10_000
/** After this long without an answer the page says the link is slow. */
export const SLOW_LINK_MS = 400

export const TIMEOUT_TEXT: EndText = {
  rows: ['The view did not answer in 10 seconds.', 'The link to the core may be slow or dropped.'],
  reopen: true,
  warning: true,
}

export function endText(reason: ViewEndReason): EndText {
  switch (reason) {
    case 'view':
      return { rows: ['The view ended.'], reopen: true, warning: false }
    case 'idle':
      return {
        rows: ['The view closed after 10 minutes without a key.'],
        reopen: true,
        warning: true,
      }
    case 'revoked':
      return {
        rows: [
          'This view is no longer allowed for your session.',
          'Sign in again or ask the owner.',
        ],
        reopen: false,
        warning: true,
      }
    case 'limit':
      return {
        rows: ['Too many views are open.', 'Close one and try again.'],
        reopen: true,
        warning: true,
      }
    case 'refused':
      return { rows: ['This view is not available to you.'], reopen: false, warning: true }
    case 'error':
      return { rows: ['The view stopped because of an error.'], reopen: true, warning: true }
    case 'disconnected':
      return { rows: ['Disconnected from the core.'], reopen: true, warning: true }
    case 'unavailable':
      return {
        rows: ['Could not open the view: the core did not answer, or it is locked.'],
        reopen: true,
        warning: true,
      }
    case 'protocol':
      return {
        rows: ['The core sent something this client will not show.'],
        reopen: true,
        warning: true,
      }
  }
}
