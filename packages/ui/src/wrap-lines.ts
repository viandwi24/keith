import { wordWrap } from './orb/subtitle.ts'
import { cells } from './text-width.ts'

/** The most rows an alert (a toast, a top alert, a caption alert) takes on a terminal this tall or taller. */
export const ALERT_MAX_LINES = 4
/** Below this many rows an alert is capped at two lines. */
export const ALERT_SHORT_ROWS = 20

/** The line cap of an alert on a terminal `rows` rows tall (an unknown height keeps the full cap). */
export function alertLinesOf(rows: number | undefined): number {
  return rows !== undefined && rows < ALERT_SHORT_ROWS ? 2 : ALERT_MAX_LINES
}

/** The longest prefix of `text` that takes at most `width` cells. */
function cutTo(text: string, width: number): string {
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > width) break
    out += ch
  }
  return out
}

/**
 * The rows of `text` in at most `maxLines` rows of `width` cells (tui-design 5.20). Words wrap at spaces; a word longer than
 * a row is cut at the width, never dropped. A text that needs more rows ends its last row with `…`. ANSI-free input; never
 * throws (an empty text gives no rows).
 */
export function wrapLines(
  text: string,
  width: number,
  maxLines: number = ALERT_MAX_LINES,
): string[] {
  const max = Math.max(1, Math.floor(width))
  const limit = Math.max(1, Math.floor(maxLines))
  const rows = wordWrap(text, max)
  if (rows.length <= limit) return rows
  const kept = rows.slice(0, limit)
  const last = kept[limit - 1] ?? ''
  kept[limit - 1] = `${cutTo(last, max - 1).trimEnd()}…`
  return kept
}
