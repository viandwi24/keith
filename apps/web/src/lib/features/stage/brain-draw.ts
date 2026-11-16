import {
  type BrainColors,
  type BrainTrace,
  LIST_ORDER,
  type Region,
  type Rgb,
  regionLabel,
  type Sample,
} from '@keith/ui/orb'
import { rgbText } from './voice-orb-draw.ts'

// The brain trace as the terminal draws it, on a canvas: a grid of square dots (the braille look), one column per sample, filled
// symmetrically around the middle line by the sample's level and coloured by the region that led it. Plus the pure view of the
// region list and the trail. Nothing here reads the DOM.

/** Canvas px between two dot centres, and the side of one dot. */
export const DOT_PITCH = 3
export const DOT_SIZE = 1.5

export interface DotCanvas2D {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
}

export interface DotColumn {
  /** Left edge of the column, in px. */
  x: number
  /** First and last dot row lit (inclusive), counted from the top. */
  from: number
  to: number
  region: Region
  level: number
}

/** Dot columns and rows that fit a canvas. */
export const gridOf = (width: number, height: number, pitch = DOT_PITCH) => ({
  cols: Math.max(1, Math.floor(width / pitch)),
  rows: Math.max(2, Math.floor(height / pitch)),
})

/** The newest samples as dot columns, newest at the right; a sample at rest lights the two rows around the middle. */
export function dotColumns(
  samples: readonly Sample[],
  width: number,
  height: number,
  pitch = DOT_PITCH,
): DotColumn[] {
  const { cols, rows } = gridOf(width, height, pitch)
  const visible = samples.slice(-cols)
  const offset = cols - visible.length
  const mid = rows / 2
  return visible.map((s, i) => {
    const half = Math.round(s.level * mid)
    return {
      x: (offset + i) * pitch,
      from: Math.max(0, Math.floor(mid) - 1 - half),
      to: Math.min(rows - 1, Math.ceil(mid) + half),
      region: s.region,
      level: s.level,
    }
  })
}

/** Opacity of a column: faint at rest, full at the peak (the terminal's fade toward the background). */
export const columnAlpha = (level: number): number => 0.35 + 0.65 * Math.max(0, Math.min(1, level))

export function drawBrainDots(
  ctx: DotCanvas2D,
  samples: readonly Sample[],
  colors: Record<Region, Rgb>,
  width: number,
  height: number,
  pitch = DOT_PITCH,
  dot = DOT_SIZE,
): void {
  ctx.clearRect(0, 0, width, height)
  const { rows } = gridOf(width, height, pitch)
  // centre the dot grid vertically in the canvas
  const top = (height - rows * pitch) / 2 + (pitch - dot) / 2
  const inset = (pitch - dot) / 2
  for (const col of dotColumns(samples, width, height, pitch)) {
    ctx.fillStyle = `rgba(${rgbText(colors[col.region])},${columnAlpha(col.level).toFixed(3)})`
    for (let y = col.from; y <= col.to; y++) ctx.fillRect(col.x + inset, top + y * pitch, dot, dot)
  }
}

/** Under this energy a region shows as idle (`○`), as in the terminal. */
export const LIT_ENERGY = 0.08
const BARS = '▁▂▃▄▅▆▇█'

export interface RegionCell {
  region: Region
  label: string
  lit: boolean
  /** A one-character level bar while lit, else empty. */
  bar: string
  /** `rgb(...)` text: the region's colour while lit, else the muted one. */
  color: string
}

/** The region list, row by row (two columns each), from the trace's energies. */
export function regionRows(trace: Pick<BrainTrace, 'level'>, colors: BrainColors): RegionCell[][] {
  const cell = (region: Region): RegionCell => {
    const e = trace.level(region)
    const lit = e >= LIT_ENERGY
    return {
      region,
      label: regionLabel(region),
      lit,
      bar: lit ? (BARS[Math.min(BARS.length - 1, Math.floor(e * BARS.length))] ?? '') : '',
      color: `rgb(${rgbText(lit ? colors.regions[region] : colors.muted)})`,
    }
  }
  const [left = [], right = []] = LIST_ORDER
  return left.map((r, i) => {
    const other = right[i]
    return other === undefined ? [cell(r)] : [cell(r), cell(other)]
  })
}

/** The trail (newest regions that fit `maxChars`), each with its colour. */
export const trailOf = (
  trace: Pick<BrainTrace, 'trailFit'>,
  colors: BrainColors,
  maxChars: number,
): { region: Region; color: string }[] =>
  trace.trailFit(maxChars).map((region) => ({
    region,
    color: `rgb(${rgbText(colors.regions[region])})`,
  }))
