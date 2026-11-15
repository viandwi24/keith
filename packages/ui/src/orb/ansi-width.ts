import { cells } from '../text-width.ts'
import { ESC, RESET, stripAnsi } from './color.ts'

// ANSI text measured in terminal cells (Bun's width). Kept apart from color.ts so the orb model stays free of Bun.

const STICKY = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'y')

/** Terminal cells a string takes once its escapes are removed. */
export const visibleWidth = (s: string): number => cells(stripAnsi(s))

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
