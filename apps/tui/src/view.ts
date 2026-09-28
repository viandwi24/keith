import {
  authorName,
  type ChatState,
  connectionLabel,
  type Entry,
  isHiddenEntry,
  type MessageEntry,
  relayFrom,
  threadLabel,
  turnLabel,
} from '@keith/client'
import type { ThreadDto } from '@keith/protocol'

/**
 * Pure presentation: turns the state into styled lines. The terminal renderer (`ui.ts`) only maps
 * `LineStyle` to colors, so what the user sees is decided and tested here.
 */

export type LineStyle =
  | 'user'
  | 'assistant'
  | 'proactive'
  | 'tool'
  | 'tool-failed'
  | 'info'
  | 'warn'
  | 'error'

export type Segment = { text: string; style: LineStyle | 'prefix' | 'muted' | 'author' }

export type EntryView = { key: string; segments: Segment[] }

export const PROACTIVE_PREFIX = 'Keith ▸ '
export const ASSISTANT_PREFIX = 'Keith  '
export const USER_PREFIX = 'You    '

/** The one-line status bar: who, which thread (its `threadLabel`), connection and turn state. */
export function statusLine(state: ChatState): string {
  const parts = ['keith']
  if (state.person) parts.push(state.person.name)
  if (state.thread) parts.push(threadLabel(state.thread, state.person))
  parts.push(connectionLabel(state.connection))
  const turn = turnLabel(state.turnState)
  if (turn) parts.push(turn)
  return parts.join(' · ')
}

export const HISTORY_MORE = '↑ older messages: PgUp or scroll up'
export const HISTORY_LOADING = '↑ loading older messages…'
export const HISTORY_START = '· start of the conversation ·'

/**
 * The line above the oldest shown message: whether scrolling up loads more history. Empty before
 * a thread is open.
 */
export function historyLine(state: ChatState): string {
  if (!state.thread) return ''
  if (state.history.loading) return HISTORY_LOADING
  return state.history.hasMore ? HISTORY_MORE : HISTORY_START
}

/** The lines to show, oldest first. Tool-step rows without text or blocks (from history) are skipped. */
export function entryViews(state: ChatState): EntryView[] {
  return state.entries.filter((e) => !isHiddenEntry(e)).map((e) => entryView(e, state))
}

/**
 * Phase 5: who wrote a user line. `null` for the signed-in person (shown as "You"), else the
 * author's name. Only group threads have other authors.
 */
export function otherAuthor(state: ChatState | undefined, entry: MessageEntry): string | null {
  if (state?.thread?.kind !== 'group') return null
  const id = entry.authorPersonId
  if (id === undefined || id === null || id === state.person?.id) return null
  return authorName(state, entry)
}

/** Phase 5: `(via Tony) ` for an assistant message that carries relays (`meta.relayFrom`), else ''. */
export function relayMark(entry: MessageEntry): string {
  const names = relayFrom(entry)
  return names.length > 0 ? `(via ${names.join(', ')}) ` : ''
}

/** `state` resolves group authors (phase 5). Without it, every user line is "You". */
export function entryView(entry: Entry, state?: ChatState): EntryView {
  switch (entry.kind) {
    case 'message': {
      if (entry.role === 'user') {
        const author = otherAuthor(state, entry)
        return {
          key: entry.key,
          segments: [
            {
              text: author === null ? USER_PREFIX : `${author}: `,
              style: author === null ? 'prefix' : 'author',
            },
            { text: entry.text, style: 'user' },
          ],
        }
      }
      const segments: Segment[] = entry.proactive
        ? [{ text: PROACTIVE_PREFIX, style: 'proactive' }]
        : [{ text: ASSISTANT_PREFIX, style: 'prefix' }]
      const via = relayMark(entry)
      if (via) segments.push({ text: via, style: 'muted' })
      // A reply with blocks but no text (history of a node without `ui.render@1`) shows their fallback.
      const text =
        entry.text.trim() === '' && !entry.streaming
          ? entry.ui.map((u) => u.fallbackText).join('\n')
          : entry.text
      segments.push({ text, style: entry.proactive ? 'proactive' : 'assistant' })
      if (entry.streaming) segments.push({ text: ' ▍', style: 'muted' })
      if (entry.cancelled) segments.push({ text: ' (cancelled)', style: 'muted' })
      return { key: entry.key, segments }
    }
    case 'tool': {
      const mark = entry.status === 'started' ? '…' : entry.status === 'completed' ? '✓' : '✗'
      const summary = entry.summary ? ` ${entry.summary}` : ''
      const style: LineStyle = entry.status === 'failed' ? 'tool-failed' : 'tool'
      return { key: entry.key, segments: [{ text: `  ⚙ ${entry.name} ${mark}${summary}`, style }] }
    }
    case 'ui':
      // The TUI does not declare `ui.render@1`, but shows a block's fallback text if one arrives.
      return { key: entry.key, segments: [{ text: entry.fallbackText, style: 'assistant' }] }
    case 'notice': {
      const label = entry.level === 'info' ? 'ℹ ' : entry.level === 'warn' ? '⚠ ' : '✗ '
      return { key: entry.key, segments: [{ text: `${label}${entry.text}`, style: entry.level }] }
    }
  }
}

/** Plain text of an entry, for tests and logs. */
export function entryText(entry: Entry, state?: ChatState): string {
  return entryView(entry, state)
    .segments.map((s) => s.text)
    .join('')
}

/** Phase 5: one row of the `/threads` list. `n` is what `/open <n>` takes. */
export type ThreadListItem = { n: number; thread: ThreadDto; label: string; open: boolean }

/**
 * Phase 5: the numbered thread list: the main thread first, then the groups, most recently updated
 * first (`state.threads` order). It follows `thread.updated` / `thread.removed`.
 */
export function threadList(state: ChatState): ThreadListItem[] {
  const main = state.threads.filter((t) => t.kind === 'direct')
  const groups = state.threads.filter((t) => t.kind !== 'direct')
  return [...main, ...groups].map((thread, i) => ({
    n: i + 1,
    thread,
    label: threadLabel(thread, state.person),
    open: state.thread?.id === thread.id,
  }))
}

export const THREADS_HELP = '/open <n> switches · Esc hides'

/** Phase 5: the lines of the `/threads` panel. The open thread is marked with `•`. */
export function threadListLines(state: ChatState): string[] {
  const items = threadList(state)
  if (items.length === 0) return ['No threads yet.', THREADS_HELP]
  return [...items.map((i) => `${i.open ? '•' : ' '} ${i.n}  ${i.label}`), THREADS_HELP]
}

/** Phase 5: a line typed in the input that is a TUI command rather than a message. */
export type Command = { kind: 'threads' } | { kind: 'open'; n: number | null }

/**
 * Parses `/threads` and `/open <n>`. Anything else (including other `/…` text) is a message for
 * Keith and returns null. `n` is null when `/open` has no valid number.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim()
  if (trimmed === '/threads') return { kind: 'threads' }
  const open = /^\/open(?:\s+(\S+))?$/.exec(trimmed)
  if (!open) return null
  const arg = open[1]
  const n = arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null
  return { kind: 'open', n }
}
