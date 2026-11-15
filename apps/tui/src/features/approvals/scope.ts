import { routeOf } from '@keith/app-model'
import type { AttentionItem } from '@keith/client'
import type { Approvals } from './use-attention.ts'

/** The same approvals, narrowed to the items `keep` accepts (the answers still go through the full list). */
export function scopeApprovals(
  approvals: Approvals,
  keep: (item: AttentionItem) => boolean,
): Approvals {
  return {
    ...approvals,
    items: approvals.items.filter(keep),
    answerable: approvals.answerable.filter(keep),
  }
}

/**
 * What the chat and Home show as a card: only an old core's items (no `extra.consent`, ADR-0036 §7). A
 * `conversation` request is answered by typing; the rest wait in the Inbox screen.
 */
export const chatScope = (approvals: Approvals): Approvals =>
  scopeApprovals(approvals, (item) => routeOf(item) === 'legacy')
