import { type ChatState, connectionLabel, type Entry, turnLabel } from '@keith/client'

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

export type Segment = { text: string; style: LineStyle | 'prefix' | 'muted' }

export type EntryView = { key: string; segments: Segment[] }

export const PROACTIVE_PREFIX = 'Keith ▸ '
export const ASSISTANT_PREFIX = 'Keith  '
export const USER_PREFIX = 'You    '

/** The one-line status bar: who, which thread, connection and turn state. */
export function statusLine(state: ChatState): string {
  const parts = ['keith']
  if (state.person) parts.push(state.person.name)
  if (state.thread) parts.push(state.thread.title)
  parts.push(connectionLabel(state.connection))
  const turn = turnLabel(state.turnState)
  if (turn) parts.push(turn)
  return parts.join(' · ')
}

export function entryView(entry: Entry): EntryView {
  switch (entry.kind) {
    case 'message': {
      if (entry.role === 'user') {
        return {
          key: entry.key,
          segments: [
            { text: USER_PREFIX, style: 'prefix' },
            { text: entry.text, style: 'user' },
          ],
        }
      }
      const segments: Segment[] = entry.proactive
        ? [{ text: PROACTIVE_PREFIX, style: 'proactive' }]
        : [{ text: ASSISTANT_PREFIX, style: 'prefix' }]
      segments.push({ text: entry.text, style: entry.proactive ? 'proactive' : 'assistant' })
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
export function entryText(entry: Entry): string {
  return entryView(entry)
    .segments.map((s) => s.text)
    .join('')
}
