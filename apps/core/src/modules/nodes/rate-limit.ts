// Per-node message budget (ADR-0027 §28, docs/specs/nodes.md "Limits").

export interface RateLimit {
  /** Messages a node socket may send in one sliding window. */
  max: number
  windowMs: number
  /** Drops that continue for this long close the socket with 4008. */
  closeAfterMs: number
  /** Minimum time between two `node.rate_limited` audit rows of one node. */
  auditEveryMs: number
}

export const DEFAULT_RATE_LIMIT: RateLimit = {
  max: 200,
  windowMs: 10_000,
  closeAfterMs: 30_000,
  auditEveryMs: 300_000,
}

export interface RateLimiter {
  /** False when the message is over the window and must be dropped. */
  admit(): boolean
  /** True when drops have continued for `closeAfterMs`: the socket should close. */
  overloaded(): boolean
}

/**
 * One limiter per node socket. Admitted messages sit in a sliding window; a message over the
 * window is dropped. An overload starts with the first drop after a calm window and ends with
 * the first window without drops, so a node that keeps flooding is caught and a burst is not.
 */
export function createRateLimiter(limit: RateLimit, now: () => number): RateLimiter {
  const admitted: number[] = []
  let lastDrop: number | undefined
  let overloadSince: number | undefined
  return {
    admit() {
      const at = now()
      while (admitted.length > 0 && (admitted[0] ?? 0) <= at - limit.windowMs) admitted.shift()
      if (admitted.length < limit.max) {
        admitted.push(at)
        return true
      }
      if (lastDrop === undefined || at - lastDrop > limit.windowMs) overloadSince = at
      lastDrop = at
      return false
    },
    overloaded() {
      return overloadSince !== undefined && now() - overloadSince >= limit.closeAfterMs
    },
  }
}
