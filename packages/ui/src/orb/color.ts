import { cells } from '../text-width.ts'
import type { ColorDepth } from '../theme.ts'

// Pure ANSI colour helpers for the orb: no theme, no env. Colours arrive as rgb arguments (the Ink
// layer resolves them from theme tokens). `none` depth returns plain text with no escape at all.

export type Rgb = readonly [number, number, number]

/** How to write a colour: the terminal's depth, and the background that "fading out" tends to. */
export interface ColorEnv {
  depth: ColorDepth
  /** The rgb a faded colour approaches (dark theme: near black; light theme: near white). */
  background: Rgb
}

export const ESC = String.fromCharCode(27)
export const RESET = `${ESC}[0m`
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g')

const STICKY = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'y')

export const stripAnsi = (s: string): string => s.replace(ANSI, '')
/** Terminal cells a string takes once its escapes are removed. */
export const visibleWidth = (s: string): number => cells(stripAnsi(s))

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

/** Move `rgb` toward `background` by `1 - k` (k = 1 keeps it, k = 0 is the background). */
export function fade(rgb: Rgb, k: number, background: Rgb): Rgb {
  return [
    clamp(background[0] + (rgb[0] - background[0]) * k),
    clamp(background[1] + (rgb[1] - background[1]) * k),
    clamp(background[2] + (rgb[2] - background[2]) * k),
  ]
}

const LEVELS = [0, 95, 135, 175, 215, 255] as const

function nearestLevel(v: number): number {
  let best = 0
  for (let i = 1; i < LEVELS.length; i++) {
    if (Math.abs((LEVELS[i] ?? 0) - v) < Math.abs((LEVELS[best] ?? 0) - v)) best = i
  }
  return best
}

const dist = (a: Rgb, b: Rgb): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** The xterm-256 index closest to an rgb: the 6x6x6 cube or the 24-step grey ramp. */
export function quantize256(rgb: Rgb): number {
  const [r, g, b] = [nearestLevel(rgb[0]), nearestLevel(rgb[1]), nearestLevel(rgb[2])]
  const cube: Rgb = [LEVELS[r] ?? 0, LEVELS[g] ?? 0, LEVELS[b] ?? 0]
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const step = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)))
  const grey = 8 + step * 10
  return dist(rgb, [grey, grey, grey]) < dist(rgb, cube) ? 232 + step : 16 + 36 * r + 6 * g + b
}

/** The SGR foreground code of the 16-colour palette (30-37, or 90-97 when bright). */
export function quantize16(rgb: Rgb): number {
  const max = Math.max(rgb[0], rgb[1], rgb[2])
  const bit = (v: number) => (v > max * 0.55 && max > 64 ? 1 : 0)
  const idx = bit(rgb[0]) | (bit(rgb[1]) << 1) | (bit(rgb[2]) << 2)
  if (max <= 64) return 90
  return (max >= 200 ? 90 : 30) + idx
}

/** The foreground escape of a colour at a depth; `''` in none depth. */
export function sgr(rgb: Rgb, depth: ColorDepth): string {
  switch (depth) {
    case 'none':
      return ''
    case 'truecolor':
      return `${ESC}[38;2;${clamp(rgb[0])};${clamp(rgb[1])};${clamp(rgb[2])}m`
    case '256':
      return `${ESC}[38;5;${quantize256(rgb)}m`
    default:
      return `${ESC}[${quantize16(rgb)}m`
  }
}

/** Wrap text in a colour and a reset; plain text where there is no colour. */
export function paint(text: string, rgb: Rgb, depth: ColorDepth): string {
  const code = sgr(rgb, depth)
  return code === '' ? text : `${code}${text}${RESET}`
}

/** Bold on or off by depth (it survives none depth: bold is not a colour). */
export const bold = (text: string): string => `${ESC}[1m${text}${RESET}`

/** Cut a string with escapes to `width` cells; closes the colour when it cut. */
export function clipAnsi(line: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(line) <= width) return line
  let out = ''
  let used = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === ESC) {
      STICKY.lastIndex = i
      const m = STICKY.exec(line)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    const ch = String.fromCodePoint(line.codePointAt(i) ?? 32)
    const w = cells(ch)
    if (used + w > width) break
    out += ch
    used += w
    i += ch.length
  }
  return `${out}${RESET}`
}
