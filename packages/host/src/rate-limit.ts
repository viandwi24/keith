import type { Clock, RateLimit } from './types.ts'

const MAX_KEYS = 10_000

/** A fixed-window counter per key, on the injected clock (never `Date.now` directly: tests move it). */
export function createRateLimiter(clock: Clock) {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** Takes one slot; `undefined` when allowed, else the milliseconds until the window ends. */
    take(key: string, limit: RateLimit): number | undefined {
      const now = clock.now()
      if (windows.size > MAX_KEYS) {
        for (const [k, w] of windows) if (now - w.start >= limit.windowMs) windows.delete(k)
        if (windows.size > MAX_KEYS) windows.clear()
      }
      const w = windows.get(key)
      if (w === undefined || now - w.start >= limit.windowMs) {
        windows.set(key, { start: now, count: 1 })
        return undefined
      }
      if (w.count >= limit.max) return Math.max(1, w.start + limit.windowMs - now)
      w.count += 1
      return undefined
    },
  }
}
