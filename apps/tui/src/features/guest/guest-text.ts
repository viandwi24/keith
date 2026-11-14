/** The fixed words and pure helpers of the guest screen (docs/specs/tui.md, "Guest mode"). */

/** What the screen says in the empty conversation: what the visitor can ask about. */
export const GUEST_EMPTY = [
  "Ask about the owner's public notes.",
  'This assistant can only read what the owner made public. It cannot see anything private.',
] as const

/** Commands a visitor may type: nothing else starts with `/` (no tasks, nodes, manage, or sign in). */
export const GUEST_COMMANDS: readonly string[] = ['/help', '/quit']

export const GUEST_HELP = 'Type a message and press enter. /quit (or esc) ends the chat.'
export const GUEST_UNKNOWN_COMMAND = 'That command is not available in guest chat. Try /help.'

/** `19 of 20 messages left`, or nothing while unknown. */
export function leftText(left: number | undefined, max: number | undefined): string {
  if (left === undefined) return ''
  return max === undefined ? `${left} messages left` : `${left} of ${max} messages left`
}

/** `ends in 1 h 58 min`, `ends in 12 min`, `ends in under a minute`, `ended`. */
export function endsText(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'ended'
  const minutes = Math.ceil(ms / 60_000)
  if (ms < 60_000) return 'ends in under a minute'
  if (minutes < 60) return `ends in ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `ends in ${h} h` : `ends in ${h} h ${m} min`
}

/** Shown once the owner opened the live session. */
export const WATCHED_TEXT = 'The owner is watching this live chat.'
