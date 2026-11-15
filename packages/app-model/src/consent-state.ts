import type { AttentionItem } from '@keith/client/browser'
import { actionOfItem, hidesTaskGrant } from './approval-headline.ts'
import { isScopable, isWaitingForOwner, lifeOf } from './approval-state.ts'
import { remaining } from './step-up-state.ts'

/**
 * How a pending approval reaches the person (ADR-0036 §4 and §7):
 * - `conversation`: the person's own request, answered by their next chat message (no card in the chat);
 * - `device`: confirmed on a trusted device, in the Inbox;
 * - `other`: a decision between two people (a member's request the owner answers), in the Inbox;
 * - `legacy`: a core that sends no `extra.consent`: the card stays in the chat, as before.
 */
export type ApprovalRoute = 'conversation' | 'device' | 'other' | 'legacy'

/** The tier the core stored on the item (`extra.consent`), or undefined (an old core, or an unknown value). */
export function consentOf(item: AttentionItem): 'conversation' | 'device' | undefined {
  const value = item.extra?.consent
  return value === 'conversation' || value === 'device' ? value : undefined
}

const hasAsker = (item: AttentionItem): boolean =>
  typeof item.extra?.askedBy === 'string' && item.extra.askedBy !== ''

/** The route of one approval for the signed-in person. */
export function routeOf(item: AttentionItem): ApprovalRoute {
  if (hasAsker(item)) return 'other'
  const tier = consentOf(item)
  if (tier === undefined) return 'legacy'
  return tier
}

/** Whether the item is answered by the person's next chat message (it has no card and no key shortcuts in the chat). */
export const isConversation = (item: AttentionItem): boolean => routeOf(item) === 'conversation'

export interface ApprovalGroups {
  /** Cards that stay in the chat (an old core). */
  legacy: AttentionItem[]
  conversation: AttentionItem[]
  /** `device` and `other`: the Inbox. */
  inbox: AttentionItem[]
}

/** Splits approvals (kept in their order) by route. */
export function groupApprovals(items: readonly AttentionItem[]): ApprovalGroups {
  const groups: ApprovalGroups = { legacy: [], conversation: [], inbox: [] }
  for (const item of items) {
    const route = routeOf(item)
    if (route === 'legacy') groups.legacy.push(item)
    else if (route === 'conversation') groups.conversation.push(item)
    else groups.inbox.push(item)
  }
  return groups
}

/**
 * Whether the card offers "Allow for task": only an item the core marks scopable, never a
 * `conversation` request, never a persona, model, style or status tool (a grant means nothing there).
 */
export const offersTaskGrant = (item: AttentionItem): boolean =>
  isScopable(item) && !isConversation(item) && !hidesTaskGrant(item.toolName)

const MAX_SUMMARY = 80

const clipSummary = (text: string): string =>
  text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1)}…`

/** One line of what the request is about (no actor): `switch the persona to butler`, `run \`df -h\` on laptop-e`. */
export function summaryOf(item: AttentionItem): string {
  const action = actionOfItem(item) ?? `call ${item.toolName}`
  const asker = item.extra?.askedByName ?? item.extra?.askedBy
  return clipSummary(
    typeof asker === 'string' && asker !== '' ? `${asker} asks to ${action}` : action,
  )
}

/** `expires in 9:41`, `expires in 3 h 05 min`, or `expired` once the time is up. */
export function expiresIn(expiresAt: number, now: number): string {
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  const hours = Math.floor(left / 3_600_000)
  if (hours < 1) return `expires in ${remaining(left)}`
  const minutes = Math.floor((left % 3_600_000) / 60_000)
  return `expires in ${hours} h ${String(minutes).padStart(2, '0')} min`
}

export interface QuietLine {
  /** `conversation`: answer by typing; `inbox`: confirm in the Inbox. */
  kind: 'conversation' | 'inbox'
  /** The whole line, parts joined by ` · ` (the clients draw the `details` link after it). */
  text: string
  /** The part about the request. */
  summary: string
  /** `expires in 4:32` / `expired`, absent when the core sent no expiry. */
  expiry: string | undefined
  /** The item the `details` link opens in the Inbox. */
  itemId: string
}

export const CONVERSATION_LEAD = 'Keith is waiting for your yes or no'
export const INBOX_LEAD = 'Confirm in the Inbox'
export const OWNER_LEAD = 'Waiting for the owner to approve'

/**
 * The quiet line above the composer (ADR-0036 §7): one line instead of a card. A `conversation`
 * request wins (Keith's own message asked the question); else the oldest `device` or `other` one says
 * where to confirm. `legacy` items have their card in the chat and no line. `undefined` when nothing waits.
 * `inboxHint` names how the client opens the Inbox (the TUI: the key or command).
 */
export function quietLineOf(
  items: readonly AttentionItem[],
  now: number,
  inboxHint?: string,
): QuietLine | undefined {
  const groups = groupApprovals(items)
  const first = groups.conversation[0] ?? groups.inbox[0]
  if (first === undefined) return undefined
  const kind = groups.conversation[0] !== undefined ? 'conversation' : 'inbox'
  const lead =
    kind === 'conversation'
      ? CONVERSATION_LEAD
      : isWaitingForOwner(first)
        ? OWNER_LEAD
        : inboxHint === undefined
          ? INBOX_LEAD
          : `${INBOX_LEAD} (${inboxHint})`
  const life = lifeOf(first, now)
  const expiry = life.expiresAt === undefined ? undefined : expiresIn(life.expiresAt, now)
  const summary = summaryOf(first)
  return {
    kind,
    text: [lead, summary, expiry].filter((part) => part !== undefined).join(' · '),
    summary,
    expiry,
    itemId: first.id,
  }
}

/**
 * The ids of requests that need the Inbox (`device`, `other`; not a member's own wait for the owner) and
 * were not announced yet: the clients toast "Confirm in the Inbox" once each (`seen` is updated).
 */
export function newInboxIds(items: readonly AttentionItem[], seen: Set<string>): string[] {
  const fresh: string[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    const route = routeOf(item)
    if ((route !== 'device' && route !== 'other') || isWaitingForOwner(item)) continue
    seen.add(item.id)
    fresh.push(item.id)
  }
  return fresh
}

export const INBOX_TOAST = 'Confirm in the Inbox'
