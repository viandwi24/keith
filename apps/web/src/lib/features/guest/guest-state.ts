// The state of one guest chat, as pure transitions (docs/specs/guests.md, "Guest page"; the TUI's `use-guest-chat.ts` is the model).
// The controller does the I/O; every failure lands in a state with one sentence.
import {
  GUEST_END_TEXT,
  type GuestChatEvent,
  type GuestError,
  guestFailureText,
} from '@keith/client/browser'

/** `opening`: asking for a session; `ready`: chatting; `refused`: no session could start; `ended`: the chat is over. */
export type GuestPhase = 'opening' | 'ready' | 'refused' | 'ended'

export type GuestBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error' }

export type GuestItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; blocks: GuestBlock[] }
  | { id: string; kind: 'notice'; text: string }

/** Opening again may work after these (the core was busy, over a cap for now, or unreachable). */
const RETRYABLE = new Set(['busy', 'cap', 'rate-limited', 'unreachable', 'unavailable'])

export interface GuestRefusal {
  phase: 'refused'
  endText: string
  retryable: boolean
}

/** The state after `open()` failed. */
export const refusalOf = (error: GuestError): GuestRefusal => ({
  phase: 'refused',
  endText: guestFailureText(error),
  retryable: RETRYABLE.has(error.kind),
})

/** A failed send: an ended or no-longer-valid chat is over; anything else leaves the chat usable with one line. */
export function sendFailureOf(
  error: GuestError,
): { phase: 'ended'; endText: string } | { problem: string } {
  return error.kind === 'ended' || error.kind === 'unauthorized'
    ? { phase: 'ended', endText: guestFailureText(error) }
    : { problem: guestFailureText(error) }
}

/** The state after the last message: the core ends the chat itself (turn cap), so it is over now. */
export const CAPPED = { phase: 'ended', endText: GUEST_END_TEXT['turn-cap'] } as const

/** An answer streams into its assistant item: text appends to the last text block, a tool call updates its block. */
export function withEvent(
  items: GuestItem[],
  assistantId: string,
  event: GuestChatEvent,
): GuestItem[] {
  if (event.type !== 'text' && event.type !== 'tool') return items
  return items.map((item) => {
    if (item.id !== assistantId || item.kind !== 'assistant') return item
    const blocks = [...item.blocks]
    if (event.type === 'text') {
      const last = blocks.at(-1)
      if (last?.kind === 'text')
        blocks[blocks.length - 1] = { kind: 'text', text: last.text + event.delta }
      else blocks.push({ kind: 'text', text: event.delta })
    } else {
      const at = blocks.findIndex((b) => b.kind === 'tool' && b.id === event.id)
      const before = at === -1 ? undefined : blocks[at]
      const name = event.name !== '' ? event.name : before?.kind === 'tool' ? before.name : 'tool'
      const block: GuestBlock = { kind: 'tool', id: event.id, name, state: event.state }
      if (at === -1) blocks.push(block)
      else blocks[at] = block
    }
    return { ...item, blocks }
  })
}

/** An assistant item with nothing in it yet is the "thinking" line, not an empty message. */
export const isEmptyAnswer = (item: GuestItem): boolean =>
  item.kind === 'assistant' && item.blocks.length === 0

/** What the page says in the empty conversation: what the visitor can ask about. */
export const GUEST_EMPTY = [
  "Ask about the owner's public notes.",
  'This assistant can only read what the owner made public. It cannot see anything private.',
] as const

/** Shown once the owner opened the live session. */
export const WATCHED_TEXT = 'The owner is watching this live chat.'

/** `19 of 20 messages left`, or nothing while unknown. */
export function leftText(left: number | undefined, max: number | undefined): string {
  if (left === undefined) return ''
  return max === undefined ? `${left} messages left` : `${left} of ${max} messages left`
}

/** `ends in 1 h 58 min`, `ends in 12 min`, `ends in under a minute`, `ended`. */
export function endsText(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'ended'
  if (ms < 60_000) return 'ends in under a minute'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `ends in ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `ends in ${h} h` : `ends in ${h} h ${m} min`
}
