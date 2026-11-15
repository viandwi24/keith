import { describe, expect, test } from 'bun:test'
import { barsOf, inRunOrder, metricOf } from './logs-chart.ts'
import { CALL_ERR, CALL_OK } from './testing/logs-fixtures.ts'

describe('barsOf', () => {
  test('no values, no bars', () => {
    expect(barsOf([], { width: 100, height: 50 })).toEqual([])
  })

  test('the largest value fills the height; the bars stand on the baseline', () => {
    const bars = barsOf([10, 5, 0], { width: 90, height: 40 })
    expect(bars.map((b) => b.height)).toEqual([40, 20, 0])
    expect(bars.map((b) => b.y)).toEqual([0, 20, 40])
  })

  test('every bar sits inside the width, left to right', () => {
    const bars = barsOf([1, 1, 1, 1], { width: 80, height: 10 })
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(80)
    }
    expect(bars.map((b) => b.x)).toEqual([...bars.map((b) => b.x)].sort((a, b) => a - b))
  })

  test('a shared peak scales two series alike', () => {
    const bars = barsOf([5], { width: 10, height: 40, peak: 10 })
    expect(bars[0]?.height).toBe(20)
  })

  test('all zero is a flat chart, not NaN', () => {
    expect(barsOf([0, 0], { width: 10, height: 10 }).every((b) => b.height === 0)).toBe(true)
  })
})

describe('metricOf', () => {
  test('reads the figure a metric charts', () => {
    expect(metricOf(CALL_OK, 'tokens-in')).toBe(CALL_OK.tokensIn)
    expect(metricOf(CALL_OK, 'tokens-out')).toBe(CALL_OK.tokensOut)
    expect(metricOf(CALL_OK, 'cost')).toBe(CALL_OK.costMicro ?? 0)
  })

  test('an unreported cache is zero', () => {
    expect(metricOf({ ...CALL_ERR, cacheRead: null }, 'cache')).toBe(0)
  })
})

describe('inRunOrder', () => {
  test('oldest first', () => {
    const a = { ...CALL_OK, startedAt: 2 }
    const b = { ...CALL_ERR, startedAt: 1 }
    expect(inRunOrder([a, b]).map((c) => c.startedAt)).toEqual([1, 2])
  })
})
