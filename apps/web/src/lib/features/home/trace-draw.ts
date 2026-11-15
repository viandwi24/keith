import type { Region, Rgb, Sample } from '@keith/ui/orb'
import { type Canvas2D, rgba } from './orb-draw.ts'

// The brain wave as bars mirrored around the middle line, one column per sample, newest at the right.

export interface Bar {
  x: number
  /** Top and bottom of the bar in pixels. */
  y0: number
  y1: number
  region: Region
  level: number
}

/** Columns that fit a width. */
export const barsFor = (width: number, barWidth: number): number =>
  Math.max(1, Math.floor(width / barWidth))

export function traceBars(
  samples: readonly Sample[],
  width: number,
  height: number,
  barWidth: number,
): Bar[] {
  const cols = barsFor(width, barWidth)
  const visible = samples.slice(-cols)
  const offset = cols - visible.length
  const mid = height / 2
  return visible.map((s, i) => {
    const half = Math.max(1, s.level * mid)
    return {
      x: (offset + i) * barWidth,
      y0: mid - half,
      y1: mid + half,
      region: s.region,
      level: s.level,
    }
  })
}

export function drawTrace(
  ctx: Canvas2D,
  samples: readonly Sample[],
  colors: Record<Region, Rgb>,
  width: number,
  height: number,
  barWidth: number,
): void {
  ctx.clearRect(0, 0, width, height)
  for (const bar of traceBars(samples, width, height, barWidth)) {
    ctx.fillStyle = rgba(colors[bar.region], 0.35 + 0.65 * bar.level)
    ctx.fillRect(bar.x, bar.y0, Math.max(1, barWidth - 1), bar.y1 - bar.y0)
  }
}
