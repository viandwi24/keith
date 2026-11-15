import type { ColorDepth } from '../theme.ts'
import { clipAnsi, visibleWidth } from './ansi-width.ts'
import { RESET, type Rgb, sgr } from './color.ts'

// btop-style panel frames: rounded corners, labels set into the border as ` label ` tags, hotkey
// letters in the accent colour. Every row is exactly `width` cells.

export interface Tag {
  text: string
  /** colour the first letter with the accent (a hotkey) */
  hot?: boolean
}

/** Escapes (empty in none depth) for the parts of a frame. */
export interface FrameStyle {
  border: string
  text: string
  accent: string
}

export interface FrameColors {
  border: Rgb
  text: Rgb
  accent: Rgb
}

export function frameStyle(colors: FrameColors, depth: ColorDepth): FrameStyle {
  return {
    border: sgr(colors.border, depth),
    text: sgr(colors.text, depth),
    accent: sgr(colors.accent, depth),
  }
}

const paint = (code: string, text: string) =>
  code === '' || text === '' ? text : `${code}${text}${RESET}`

function renderTag(t: Tag, st: FrameStyle): string {
  const label = t.hot
    ? paint(st.accent, t.text.slice(0, 1)) + paint(st.text, t.text.slice(1))
    : paint(st.text, t.text)
  return paint(st.border, ' ') + label + paint(st.border, ' ')
}

const tags = (list: readonly Tag[] | undefined, st: FrameStyle): string =>
  (list ?? []).map((t) => renderTag(t, st)).join(paint(st.border, '─'))

interface EdgeOptions {
  width: number
  corners: [string, string]
  left?: readonly Tag[] | undefined
  center?: string | undefined
  right?: readonly Tag[] | undefined
}

function edge(o: EdgeOptions, st: FrameStyle): string {
  const room = Math.max(0, o.width - 2)
  const line = (n: number) => paint(st.border, '─'.repeat(Math.max(0, n)))
  const corners = (inner: string) =>
    paint(st.border, o.corners[0]) + inner + paint(st.border, o.corners[1])
  // inner = '─' left ... fill ... right '─'; what does not fit is dropped, right and centre first
  let left = tags(o.left, st)
  let right = tags(o.right, st)
  let center = o.center ? paint(st.text, ` ${o.center} `) : ''
  const lead = left ? 1 : 0
  const total = () =>
    lead + visibleWidth(left) + visibleWidth(center) + visibleWidth(right) + (right ? 1 : 0)
  if (total() > room) right = ''
  if (total() > room) center = ''
  if (total() > room) left = clipAnsi(left, Math.max(0, room - lead))
  const used = Math.min(room, total())
  let fill = Math.max(0, room - used)
  let inner = (left ? line(1) : '') + left
  if (center) {
    const before = Math.floor(fill / 2)
    inner += line(before) + center
    fill -= before
  }
  return corners(inner + line(fill) + right + (right ? line(1) : ''))
}

export interface FrameOptions {
  width: number
  style: FrameStyle
  top?: readonly Tag[] | undefined
  center?: string | undefined
  topRight?: readonly Tag[] | undefined
  bottom?: readonly Tag[] | undefined
  /** body lines; each may contain ANSI and is clipped or padded to the inner width */
  body: readonly string[]
}

/** Render a framed panel as rows of exactly `width` visible cells (width is at least 2). */
export function frame(o: FrameOptions): string[] {
  const st = o.style
  const width = Math.max(2, o.width)
  const inner = width - 2
  const top = edge(
    { width, corners: ['╭', '╮'], left: o.top, center: o.center, right: o.topRight },
    st,
  )
  const bottom = edge({ width, corners: ['╰', '╯'], left: o.bottom }, st)
  const side = paint(st.border, '│')
  const rows = o.body.map((raw) => {
    const line = clipAnsi(raw, inner)
    const fill = ' '.repeat(Math.max(0, inner - visibleWidth(line)))
    return `${side}${line}${fill}${side}`
  })
  return [top, ...rows, bottom]
}
