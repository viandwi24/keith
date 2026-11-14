import { type ColorEnv, fade, RESET, type Rgb, sgr } from './color.ts'
import { ORB_RADIUS, type Particle } from './orb.ts'

// Braille raster: each terminal cell holds 2x4 dots. Cells are about twice as tall as wide and a
// braille dot is square, so the orb stays round without correction; `cellAspect` (cell width over
// cell height, 0.5 by default) corrects terminals whose cells differ.

/** Bit of the dot at (row 0..3, column 0..1) inside a braille cell (U+2800 + bits). */
export const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

/** Brightness 0..1 of a particle -> how far its colour moves toward the background. */
/** Steps of brightness: fewer distinct colours means fewer escapes per row, which Ink pays for every frame. */
export const BRIGHTNESS_STEPS = 8

const brightness = (a: number): number =>
  0.25 + (0.75 * Math.round(a * BRIGHTNESS_STEPS)) / BRIGHTNESS_STEPS

/** Render particles into `rows` strings of exactly `cols` cells (coloured braille; plain in none depth). */
export function rasterize(
  particles: readonly Particle[],
  cols: number,
  rows: number,
  rgb: Rgb,
  env: ColorEnv,
  cellAspect = 0.5,
): string[] {
  const dotsW = cols * 2
  const dotsH = rows * 4
  // Physical size with a cell height of 1: a cell is `cellAspect` wide, a dot is cellAspect/2 wide
  // and 1/4 tall. Fit the orb by physical size.
  const pitchX = cellAspect / 2
  const pitchY = 1 / 4
  const scale = Math.min(cols * cellAspect, rows) / 2 / ORB_RADIUS
  const bits = new Uint8Array(cols * rows)
  const bright = new Float32Array(cols * rows)
  for (const p of particles) {
    const dx = Math.round(dotsW / 2 + (p.x * scale) / pitchX)
    const dy = Math.round(dotsH / 2 + (p.y * scale) / pitchY)
    if (dx < 0 || dy < 0 || dx >= dotsW || dy >= dotsH) continue
    const cell = (dy >> 2) * cols + (dx >> 1)
    bits[cell] = (bits[cell] ?? 0) | (DOT_BITS[dy & 3]?.[dx & 1] ?? 0)
    bright[cell] = Math.max(bright[cell] ?? 0, p.a)
  }
  const colored = env.depth !== 'none'
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    let prev = ''
    for (let x = 0; x < cols; x++) {
      const b = bits[y * cols + x] ?? 0
      if (b === 0) {
        line += ' '
        continue
      }
      if (colored) {
        const code = sgr(
          fade(rgb, brightness(bright[y * cols + x] ?? 0), env.background),
          env.depth,
        )
        if (code !== prev) {
          line += code
          prev = code
        }
      }
      line += String.fromCharCode(0x2800 + b)
    }
    lines.push(colored && prev !== '' ? `${line}${RESET}` : line)
  }
  return lines
}
