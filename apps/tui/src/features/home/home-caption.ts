import { ALERT_MAX_LINES, cells, wrapLines } from '@keith/ui'

/** The widest a caption row gets, like the subtitle. */
export const CAPTION_MAX = 76

/** One caption row: `text` may mark commands in backticks (drawn in accent). */
export interface CaptionRow {
  text: string
  tone: 'danger' | 'muted'
}

/** `http://127.0.0.1:7420` to `http://127.0.0.1:…:7420`: the middle goes, the ends stay. */
export function shortenMiddle(text: string, max: number): string {
  if (cells(text) <= max) return text
  if (max <= 1) return '…'
  const tail = Math.min(5, Math.floor((max - 1) / 2))
  const head = max - 1 - tail
  const chars = [...text]
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/**
 * What Home says when it cannot talk to the core (tui-design 5.16): up to four rows, each wrapped on words to the caption
 * width (a long address is cut at the width, never dropped; the last row ends with `…` only past the fourth row). Core
 * down is the error alone (danger), no tip. Signed out: row 1 names the state (danger), the rest the action (muted; the
 * `enter` key in accent).
 */
export function alertCaption(
  kind: 'logged-out' | 'core-down',
  core: string,
  width: number,
  maxLines: number = ALERT_MAX_LINES,
): CaptionRow[] {
  const room = Math.max(10, Math.min(width, CAPTION_MAX))
  if (kind === 'core-down') {
    return wrapLines(`✕ Cannot reach the core at ${core}`, room, maxLines).map((text) => ({
      text,
      tone: 'danger',
    }))
  }
  const action = wrapLines(`Press enter to sign in to ${core}`, room, Math.max(1, maxLines - 1))
  return [
    { text: '○ Signed out', tone: 'danger' },
    // the key is drawn in accent: marked on the row it starts in (a row break never splits a mark)
    ...action.map((text) => ({ text: text.replace('enter', '`enter`'), tone: 'muted' as const })),
  ]
}
