import { describe, expect, test } from 'bun:test'
import { cacheHitRatio, cacheTotals, LOW_CACHE_HIT, lowCacheIds, percentOf } from './cache-hit.ts'

// audit F17: the cache-hit figures are derived from the stored `tokensIn` and `cacheRead`; nothing is stored for them.

const call = (id: string, startedAt: number, tokensIn: number, cacheRead: number | null) => ({
  id,
  startedAt,
  tokensIn,
  cacheRead,
})

describe('cacheHitRatio', () => {
  test('the cached share of the input, from 0 to 1', () => {
    expect(cacheHitRatio({ tokensIn: 1000, cacheRead: 900 })).toBeCloseTo(0.9, 12)
    expect(cacheHitRatio({ tokensIn: 1000, cacheRead: 0 })).toBe(0)
    expect(cacheHitRatio({ tokensIn: 100, cacheRead: 100 })).toBe(1)
  })

  test('null when the provider reported no cache figure or the call sent no input', () => {
    expect(cacheHitRatio({ tokensIn: 1000, cacheRead: null })).toBeNull()
    expect(cacheHitRatio({ tokensIn: 0, cacheRead: 0 })).toBeNull()
  })
})

describe('lowCacheIds', () => {
  test('the first call of a session is never marked, whatever its hit', () => {
    const marked = lowCacheIds([call('a', 1, 1000, 0)])
    expect(marked.size).toBe(0)
  })

  test('a later call below the line is marked; the line itself and above are not', () => {
    const rows = [
      call('first', 1, 1000, 0),
      call('low', 2, 1000, 100),
      call('edge', 3, 1000, 500),
      call('high', 4, 1000, 950),
      call('unreported', 5, 1000, null),
    ]
    expect([...lowCacheIds(rows)]).toEqual(['low'])
    expect(LOW_CACHE_HIT).toBe(0.5)
  })

  test('the first call is the earliest by start, whatever the order of the list', () => {
    const rows = [call('late', 9, 1000, 0), call('early', 1, 1000, 0)]
    expect([...lowCacheIds(rows)]).toEqual(['late'])
  })
})

describe('cacheTotals', () => {
  test('the sums over the calls that reported a cache figure, and their ratio', () => {
    const totals = cacheTotals([
      { tokensIn: 1000, cacheRead: 800 },
      { tokensIn: 500, cacheRead: null },
      { tokensIn: 1000, cacheRead: 1000 },
    ])
    expect(totals).toEqual({ tokensIn: 2000, cacheRead: 1800, ratio: 0.9 })
  })

  test('no reported figure means no ratio', () => {
    expect(cacheTotals([{ tokensIn: 1000, cacheRead: null }]).ratio).toBeNull()
    expect(cacheTotals([]).ratio).toBeNull()
  })
})

describe('percentOf', () => {
  test('a whole percent, or a dash when there is none', () => {
    expect(percentOf(0.926)).toBe('93%')
    expect(percentOf(0)).toBe('0%')
    expect(percentOf(null)).toBe('—')
  })
})
