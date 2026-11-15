import {
  type ApprovalAsk,
  askedAgo,
  askOf,
  expiresIn,
  isConversation,
  isWaitingForOwner,
  isWaitingForOwnerError,
  lifeOf,
  offersTaskGrant,
  WAITING_TEXT,
} from '@keith/app-model'
import type { AttentionItem } from '@keith/client/browser'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The node a call runs on: the core's decoration first, the call input as the fallback. */
export function nodeOf(item: AttentionItem): string | undefined {
  const input = isRecord(item.input) ? item.input : undefined
  return text(item.extra?.node) ?? text(input?.node)
}

/** The capability a call asks for (`shell.exec`, `desktop.input`), or `undefined` for a plain tool. */
export function capabilityOf(item: AttentionItem): string | undefined {
  const input = isRecord(item.input) ? item.input : undefined
  return text(item.extra?.capability) ?? text(input?.capability)
}

/** `expires in 9:41`, `expires in 3 h 05 min`, or `expired` once the time is up. */
export const countdownText = expiresIn

export interface CardView
  extends Pick<ApprovalAsk, 'headline' | 'command' | 'actions' | 'detail' | 'task'> {
  id: string
  /** The tool, or the capability the tool calls (`shell.exec`). */
  tool: string
  node: string | undefined
  /** `asked 3 h ago`, or `undefined` when the core did not say when. */
  age: string | undefined
  /** `expires in 9:41` / `expired`, or `undefined` when the core sent no expiry. */
  expiry: string | undefined
  /** The age line is amber: close to the expiry, or past it. */
  warn: boolean
  expired: boolean
  /** Offers "Allow for task" (the core drops a grant on a member's request). */
  scopable: boolean
  /** A member's own request that only the owner can answer. */
  waiting: boolean
  /** Keith asked in the chat: the next message answers; the card is the fallback (no key shortcuts). */
  conversation: boolean
}

/** What one approval card shows at `now` (epoch ms). */
export function cardOf(item: AttentionItem, now: number): CardView {
  const ask = askOf(item)
  const life = lifeOf(item, now)
  return {
    id: item.id,
    headline: ask.headline,
    command: ask.command,
    actions: ask.actions,
    detail: ask.detail,
    task: ask.task,
    tool: capabilityOf(item) ?? item.toolName,
    node: nodeOf(item),
    age: life.ageMs === undefined ? undefined : askedAgo(life.ageMs),
    expiry: life.expiresAt === undefined ? undefined : countdownText(life.expiresAt, now),
    warn: life.soon || life.expired,
    expired: life.expired,
    scopable: offersTaskGrant(item),
    waiting: isWaitingForOwner(item),
    conversation: isConversation(item),
  }
}

/** The tab-bar and rail badge of the Inbox: the pending approvals, `99+` when many, nothing at zero. */
export function inboxBadge(count: number): string | undefined {
  if (count <= 0) return undefined
  return count > 99 ? '99+' : String(count)
}

export type CardKeyAction = 'allow' | 'deny' | 'deny-reason' | 'allow-task' | 'none'

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
}

/** A text field (or anything that takes typing) holds the keys: no single-key answer then. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (target.isContentEditable === true) return true
  const tag = target.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

export interface KeyContext {
  /** The card element itself has focus (not a field or button inside it). */
  cardFocused: boolean
  /** The key's target takes typing (the reason field, the composer). */
  typing: boolean
  scopable: boolean
  /** Not answerable by this person (a member waiting for the owner). */
  readOnly: boolean
}

/**
 * The single keys of a focused approval card, as in the TUI after Tab: `y` allow, `n` deny, `N` deny
 * with a reason, `a` allow for the task (scopable only). Never while a text field has focus, never
 * with a modifier, and only when the card itself is the focused element.
 */
export function cardKeyAction(event: KeyLike, ctx: KeyContext): CardKeyAction {
  if (!ctx.cardFocused || ctx.typing || ctx.readOnly) return 'none'
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return 'none'
  switch (event.key) {
    case 'y':
      return 'allow'
    case 'n':
      return 'deny'
    case 'N':
      return 'deny-reason'
    case 'a':
      return ctx.scopable ? 'allow-task' : 'none'
    default:
      return 'none'
  }
}

/** The ids of approvals that passed their expiry and were not announced yet (`seen` is updated). */
export function newlyExpired(
  items: readonly AttentionItem[],
  now: number,
  seen: Set<string>,
): string[] {
  const fresh: string[] = []
  for (const item of items) {
    if (seen.has(item.id) || !lifeOf(item, now).expired) continue
    seen.add(item.id)
    fresh.push(item.id)
  }
  return fresh
}

/** A step-up the person dismissed: not a failure, the TUI says "Not confirmed." as info. */
export const isStepUpCancelled = (error: unknown): boolean =>
  error instanceof Error && error.name === 'StepUpCancelled'

/** The toast of a failed answer, with the TUI's texts. */
export function answerFailure(error: unknown): string {
  if (isWaitingForOwnerError(error)) return WAITING_TEXT
  return `Failed to answer: ${error instanceof Error ? error.message : String(error)}`
}
