// The `/history` rows (docs/specs/chat-context.md, "TUI"): the person's chat generations, newest first. A generation ends where the
// next generation with messages starts (a reset, `/new`); the newest is still running. A generation that ended with no messages
// after it has no time (never the epoch: `startedAt` 0 is no start). A generation a `/compact` shortened says so (`compacted 2×`).
import type { ChatGeneration } from '@keith/contracts'

export interface HistoryRow {
  generation: number
  /** `started Nov 12 09:14`, or `no messages yet` for a generation that holds none. */
  started: string
  /** `ended Nov 12 10:02 by /new`, or `running now`. */
  ended: string
  messages: string
  /** `compacted 2×` when a `/compact` run shortened this generation while it was current; absent otherwise. */
  compacted?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Local `Mon D HH:MM` of an epoch ms. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The end of a generation: the start of the next generation that holds messages (a generation with none has `startedAt` 0, the
 * core's sentinel, never a time). `undefined` when a later generation exists but none has a start: it ended by /new, untimed.
 */
function endOf(later: readonly ChatGeneration[]): number | undefined {
  return later.find((g) => g.startedAt > 0)?.startedAt
}

/** `running now` for the newest; `ended <start of the next generation with messages> by /new`, or `ended by /new` when none has one. */
function endedText(later: readonly ChatGeneration[]): string {
  if (later.length === 0) return 'running now'
  const at = endOf(later)
  return at === undefined ? 'ended by /new' : `ended ${stampOf(at)} by /new`
}

/** The rows of the list, newest first. `generations` is the core's list (oldest first). */
export function historyRowsOf(generations: readonly ChatGeneration[]): HistoryRow[] {
  const sorted = [...generations].sort((a, b) => a.generation - b.generation)
  return sorted
    .map((g, i) => {
      const later = sorted.slice(i + 1)
      const started = g.startedAt > 0 ? `started ${stampOf(g.startedAt)}` : 'no messages yet'
      const ended = endedText(later)
      const messages = g.messages === 1 ? '1 message' : `${g.messages} messages`
      const row: HistoryRow = { generation: g.generation, started, ended, messages }
      if (g.compactions > 0) row.compacted = `compacted ${g.compactions}×`
      return row
    })
    .reverse()
}
