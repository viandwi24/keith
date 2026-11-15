import type { LlmCallRecord } from '@keith/contracts'

// The Logs charts (activity-logs.md "Web"): a session's generations as bars, in the order they ran. Pure geometry: the web draws the
// rectangles as inline SVG, so a test reads the numbers without a browser.

export interface Bar {
  /** The index of the generation the bar stands for. */
  at: number
  x: number
  y: number
  width: number
  height: number
  value: number
}

export interface BarGeometry {
  width: number
  height: number
  /** The space between two bars, as a share of a bar's width. */
  gap?: number
  /** The value that fills the height; the largest value when absent (two series share one scale by passing it). */
  peak?: number
}

/**
 * One bar per value, scaled to the largest value (a zero value has no height). Bars fill the width, oldest at the left.
 * `y` is the top edge, so the bar stands on `height`.
 */
export function barsOf(values: readonly number[], g: BarGeometry): Bar[] {
  const n = values.length
  if (n === 0) return []
  const gap = g.gap ?? 0.25
  const slot = g.width / n
  const width = Math.max(1, slot / (1 + gap))
  const peak = g.peak ?? Math.max(...values, 0)
  return values.map((value, at) => {
    const h = peak <= 0 ? 0 : (value / peak) * g.height
    return { at, x: at * slot + (slot - width) / 2, y: g.height - h, width, height: h, value }
  })
}

export type ChartMetric = 'tokens-in' | 'tokens-out' | 'cost' | 'cache'

/** The figure of a generation a metric charts (cost in micro-dollars; the cache share from 0 to 1, 0 when unreported). */
export function metricOf(c: LlmCallRecord, metric: ChartMetric): number {
  switch (metric) {
    case 'tokens-in':
      return c.tokensIn
    case 'tokens-out':
      return c.tokensOut
    case 'cost':
      return c.costMicro ?? 0
    case 'cache':
      return c.cacheRead === null || c.tokensIn <= 0 ? 0 : Math.min(1, c.cacheRead / c.tokensIn)
  }
}

/** Generations in the order they ran (the list the core sends is oldest first, but a chart never trusts it). */
export const inRunOrder = (generations: readonly LlmCallRecord[]): LlmCallRecord[] =>
  [...generations].sort((a, b) => a.startedAt - b.startedAt)
