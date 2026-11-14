import { describe, expect, test } from 'bun:test'
import { createRateLimiter, DEFAULT_RATE_LIMIT, type RateLimit } from './rate-limit.ts'

const small: RateLimit = { max: 3, windowMs: 1_000, closeAfterMs: 5_000, auditEveryMs: 10_000 }

function clock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

describe('rate limiter', () => {
  test('the default budget is 200 messages per 10 s, closing after 30 s of overload', () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({
      max: 200,
      windowMs: 10_000,
      closeAfterMs: 30_000,
      auditEveryMs: 300_000,
    })
  })

  test('the message over the window is dropped, and the window slides', () => {
    const c = clock()
    const limiter = createRateLimiter(small, c.now)
    expect([limiter.admit(), limiter.admit(), limiter.admit()]).toEqual([true, true, true])
    expect(limiter.admit()).toBe(false)
    c.advance(999)
    expect(limiter.admit()).toBe(false)
    c.advance(1)
    expect(limiter.admit()).toBe(true)
  })

  test('an overload closes only when drops continue for closeAfterMs', () => {
    const c = clock()
    const limiter = createRateLimiter({ ...small, max: 1 }, c.now)
    limiter.admit() // t=0 admitted; then a message every 100 ms, most of them over the window
    let firstOverloaded: number | undefined
    for (let i = 0; i < 100; i++) {
      c.advance(100)
      if (!limiter.admit() && limiter.overloaded() && firstOverloaded === undefined) {
        firstOverloaded = c.now()
      }
    }
    // the first drop was at 100 ms, so the overload has lasted 5 s at 5100 ms
    expect(firstOverloaded).toBe(5_100)
  })

  test('a burst followed by a calm window starts a fresh overload clock', () => {
    const c = clock()
    const limiter = createRateLimiter(small, c.now)
    for (let i = 0; i < 10; i++) limiter.admit() // 3 admitted, 7 dropped at t=0
    expect(limiter.overloaded()).toBe(false)
    c.advance(10_000) // calm: no drops for longer than the window
    for (let i = 0; i < 3; i++) limiter.admit()
    // the window is full again: this drop is the start of a new overload, so the old clock (10 s
    // old, past closeAfterMs) must not be carried over
    expect(limiter.admit()).toBe(false)
    expect(limiter.overloaded()).toBe(false)
  })
})
