import { type QuietLine, quietLineOf } from '@keith/app-model'
import type { AttentionItem } from '@keith/client/browser'

export interface LineView extends QuietLine {
  /** The `details` link: the Inbox, at the card of the request. */
  href: string
  linkLabel: 'details'
}

/** The card of a request in the Inbox (`ApprovalCard` sets this id; the link scrolls to it). */
export const cardAnchor = (id: string): string => `approval-${id}`

/**
 * The quiet line above the composer (ADR-0036 §7): `Keith is waiting for your yes or no · <summary> ·
 * expires in m:ss`, or `Confirm in the Inbox · <summary>`, with a `details` link. `undefined` when no
 * request waits without a card (an old core's items keep their card in the chat).
 */
export function lineView(
  items: readonly AttentionItem[],
  now: number,
  base: string,
): LineView | undefined {
  const line = quietLineOf(items, now)
  if (line === undefined) return undefined
  return { ...line, href: `${base}/inbox#${cardAnchor(line.itemId)}`, linkLabel: 'details' }
}

/** The toast of a request that needs the Inbox: the text and its link. */
export const inboxToast = (
  base: string,
): { text: string; link: { href: string; label: string } } => ({
  text: 'Confirm in the Inbox',
  link: { href: `${base}/inbox`, label: 'Open the Inbox' },
})
