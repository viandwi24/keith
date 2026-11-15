// Scrolling rules of the conversation. Pure: the component reads the metrics of its scroll box and asks.

export interface ScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** How far from the end still counts as "at the bottom" (px): a tall message or a fractional scroll position is not a scroll up. */
export const BOTTOM_SLACK = 48

/** How near the top an upward scroll loads the older messages (px). */
export const TOP_LOAD_AT = 160

export const isAtBottom = (m: ScrollMetrics, slack = BOTTOM_SLACK): boolean =>
  m.scrollHeight - m.scrollTop - m.clientHeight <= slack

/**
 * What new content does: follow it when the person was at the bottom, or just sent a message; otherwise leave the view alone and
 * offer "jump to latest".
 */
export function onNewContent(input: {
  wasAtBottom: boolean
  justSent: boolean
}): 'follow' | 'offer-jump' {
  return input.wasAtBottom || input.justSent ? 'follow' : 'offer-jump'
}

/** Older messages are read when the person scrolls near the top and there are some to read. */
export function shouldLoadOlder(
  m: ScrollMetrics,
  state: { hasOlder: boolean; loadingOlder: boolean; loaded: boolean },
): boolean {
  return state.loaded && state.hasOlder && !state.loadingOlder && m.scrollTop <= TOP_LOAD_AT
}

/** After older messages are put above, the scroll position that keeps the same message under the eye. */
export const scrollTopAfterPrepend = (before: ScrollMetrics, afterHeight: number): number =>
  before.scrollTop + (afterHeight - before.scrollHeight)
