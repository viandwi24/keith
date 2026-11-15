import { type ChatItem, plainText, SUBTITLE_HOLD_MS } from '@keith/app-model'
import { pureCells, subtitleRowsWith } from '@keith/ui/orb'

/** The words of the newest assistant message after the last thing the person said, as plain text blocks joined. */
export function latestReply(items: readonly ChatItem[]): string {
  const last = items.at(-1)
  if (last?.kind !== 'assistant') return ''
  return last.blocks
    .flatMap((b) => (b.kind === 'text' ? [b.text] : []))
    .join('\n')
    .trim()
}

export interface SubtitleInput {
  /** The latest reply (Markdown). */
  raw: string
  /** The reply Home saw when it mounted: it is not a new reply, so it stays quiet. */
  baseline: string
  /** A turn runs now. */
  busy: boolean
  /** Milliseconds since the turn ended (or since `raw` last changed while idle). */
  idleMs: number
  holdMs?: number
}

/** The subtitle text: the plain words of the reply as it streams; after the turn they stay for the hold time, then clear. */
export function subtitleOf({
  raw,
  baseline,
  busy,
  idleMs,
  holdMs = SUBTITLE_HOLD_MS,
}: SubtitleInput): string {
  if (raw === '') return ''
  if (!busy && (raw === baseline || idleMs >= holdMs)) return ''
  return plainText(raw)
}

/** Columns that fit a pixel width at a font size (the average glyph is about 0.55 of the size). */
export const columnsFor = (widthPx: number, fontPx: number): number =>
  Math.max(16, Math.floor(widthPx / (fontPx * 0.55)))

/** The newest two rows of the typed-out text, wrapped for the columns. */
export const subtitleLines = (typed: string, columns: number, rows = 2): string[] =>
  subtitleRowsWith(typed, columns, pureCells, rows)
