import { describe, expect, test } from 'bun:test'
import { RateLimiter } from './rate-limit.ts'

describe('RateLimiter', () => {
  test('spends up to the limit inside one minute and refuses the rest', () => {
    const now = 0
    const limiter = new RateLimiter(5, () => now)
    expect(limiter.take(3)).toBe(true)
    expect(limiter.take(2)).toBe(true)
    expect(limiter.take(1)).toBe(false)
  })

  test('a refused spend costs nothing', () => {
    const limiter = new RateLimiter(5, () => 0)
    expect(limiter.take(4)).toBe(true)
    expect(limiter.take(2)).toBe(false)
    expect(limiter.take(1)).toBe(true)
  })

  test('the window slides: spends come back one minute later', () => {
    let now = 1_000
    const limiter = new RateLimiter(2, () => now)
    expect(limiter.take(1)).toBe(true)
    now += 30_000
    expect(limiter.take(1)).toBe(true)
    expect(limiter.take(1)).toBe(false)
    now += 30_000 // the first spend is exactly one minute old
    expect(limiter.take(1)).toBe(true)
    expect(limiter.take(1)).toBe(false)
  })

  test('a cost above the whole limit is always refused', () => {
    expect(new RateLimiter(3, () => 0).take(4)).toBe(false)
  })
})
