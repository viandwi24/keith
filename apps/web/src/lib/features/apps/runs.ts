// A parsed frame as rows of styled text spans (docs/specs/plugin-views.md, "Web"). The client's `parseFrame` already dropped
// everything but text and SGR; this maps its colours to CSS. Pure, and the output is data for text nodes and a `style`
// attribute: no markup is ever built from a frame.
import type { ParsedFrame, ViewRun } from '@keith/client/browser'

export interface Span {
  text: string
  /** CSS declarations (`color:…;font-weight:700`), empty for plain text. */
  style: string
}

export interface GridRow {
  key: number
  spans: Span[]
}

const HEX = /^#[0-9a-f]{6}$/i
const ANSI256 = /^ansi256\((\d{1,3})\)$/

/** The 16 named colours as tokens of the page (`--k-<token>`), so a view follows the light and dark theme. */
const NAMED: Record<string, string> = {
  black: 'bg',
  red: 'danger',
  green: 'success',
  yellow: 'warning',
  blue: 'accent',
  magenta: 'region-wernicke',
  cyan: 'info',
  white: 'text',
  blackBright: 'text-muted',
  redBright: 'danger',
  greenBright: 'success',
  yellowBright: 'warning',
  blueBright: 'accent',
  magentaBright: 'region-wernicke',
  cyanBright: 'info',
  whiteBright: 'text',
}
const NAME_BY_INDEX = Object.keys(NAMED)

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** The CSS colour of a view colour (`#rrggbb`, `ansi256(n)` or a name), or `undefined` for anything else. */
export function cssColorOf(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  if (HEX.test(spec)) return spec.toLowerCase()
  const named = NAMED[spec]
  if (named !== undefined) return `var(--k-${named})`
  const m = ANSI256.exec(spec)
  if (m === null) return undefined
  const n = Number(m[1])
  if (n > 255) return undefined
  if (n < 16) return cssColorOf(NAME_BY_INDEX[n])
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`
  }
  const i = n - 16
  const level = (c: number): number => (c === 0 ? 0 : 55 + c * 40)
  return `#${hex2(level(Math.floor(i / 36)))}${hex2(level(Math.floor(i / 6) % 6))}${hex2(level(i % 6))}`
}

/** The CSS of one run: colours (swapped for `inverse`), weight, slant, underline and strike, dim as opacity. */
export function styleOf(run: ViewRun): string {
  let fg = cssColorOf(run.fg)
  let bg = cssColorOf(run.bg)
  if (run.inverse === true) {
    const swapped = { fg: bg ?? 'var(--k-bg)', bg: fg ?? 'var(--k-text)' }
    fg = swapped.fg
    bg = swapped.bg
  }
  const css: string[] = []
  if (fg !== undefined) css.push(`color:${fg}`)
  if (bg !== undefined) css.push(`background-color:${bg}`)
  if (run.bold === true) css.push('font-weight:700')
  if (run.italic === true) css.push('font-style:italic')
  if (run.dim === true) css.push('opacity:0.6')
  const lines = [
    run.underline === true ? 'underline' : '',
    run.strike === true ? 'line-through' : '',
  ]
    .filter((l) => l !== '')
    .join(' ')
  if (lines !== '') css.push(`text-decoration:${lines}`)
  return css.join(';')
}

/** The rows of a frame: neighbouring runs of one style join; an empty line is one blank cell so it keeps its height. */
export function rowsOf(frame: ParsedFrame | undefined): GridRow[] {
  if (frame === undefined) return []
  return frame.lines.map((line, key) => {
    const spans: Span[] = []
    for (const run of line) {
      if (run.text === '') continue
      const style = styleOf(run)
      const last = spans[spans.length - 1]
      if (last !== undefined && last.style === style) last.text += run.text
      else spans.push({ text: run.text, style })
    }
    if (spans.length === 0) spans.push({ text: ' ', style: '' })
    return { key, spans }
  })
}
