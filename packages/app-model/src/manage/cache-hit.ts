import type { LlmCallRecord } from '@keith/contracts'

// The cache-hit figures of the Logs views (audit F17, docs/specs/activity-logs.md "TUI"): the share of a call's input that the
// provider read from its cache, a session's totals, and the calls to mark `↓`. Pure, derived from the stored figures (nothing
// is stored for it).

/** A call after the first of its session whose cached share is below this is marked `↓` ("low cache hit"). */
export const LOW_CACHE_HIT = 0.5

/** The figures a cache reading needs: what a call sent and what of it the cache served. */
export type CacheFigures = Pick<LlmCallRecord, 'tokensIn' | 'cacheRead'>

/**
 * The share of a call's input tokens read from the cache, from 0 to 1. Null when the provider reported no cache figure
 * (`cacheRead` null) or the call sent no input.
 */
export function cacheHitRatio(c: CacheFigures): number | null {
  if (c.cacheRead === null || c.tokensIn <= 0) return null
  return Math.min(1, c.cacheRead / c.tokensIn)
}

/** The ids of the calls a session marks `↓`: every call after the first in start order whose hit ratio is below the line. */
export function lowCacheIds(
  generations: ReadonlyArray<Pick<LlmCallRecord, 'id' | 'startedAt'> & CacheFigures>,
): Set<string> {
  const ordered = [...generations].sort((a, b) => a.startedAt - b.startedAt)
  const marked = new Set<string>()
  for (const [i, call] of ordered.entries()) {
    if (i === 0) continue
    const ratio = cacheHitRatio(call)
    if (ratio !== null && ratio < LOW_CACHE_HIT) marked.add(call.id)
  }
  return marked
}

/**
 * A session's cache totals over the calls that reported a cache figure: their input tokens, their cached tokens and the
 * ratio of the two (null when no call reported one).
 */
export function cacheTotals(generations: readonly CacheFigures[]): {
  tokensIn: number
  cacheRead: number
  ratio: number | null
} {
  let tokensIn = 0
  let cacheRead = 0
  for (const c of generations) {
    if (c.cacheRead === null) continue
    tokensIn += c.tokensIn
    cacheRead += c.cacheRead
  }
  const ratio = tokensIn > 0 ? Math.min(1, cacheRead / tokensIn) : null
  return { tokensIn, cacheRead, ratio }
}

/** A hit ratio as a whole percent (`92%`), or `—` when there is none. */
export const percentOf = (ratio: number | null): string =>
  ratio === null ? '—' : `${Math.round(ratio * 100)}%`
