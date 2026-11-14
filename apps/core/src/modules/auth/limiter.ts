/**
 * A small in-memory sliding-window limiter for the open identifier routes. It counts every call
 * the same way, whatever the identifier maps to, so the accounting never tells a known identifier
 * from an unknown one. State is per process: the durable per-(subject, address) throttle of
 * `throttle.ts` still guards the secrets.
 */
export interface Limiter {
  /** Count one hit; the seconds to wait when the key is over the limit (the hit is not counted), else undefined. */
  take(key: string): number | undefined
}

const MAX_KEYS = 10_000

export function createLimiter(options: {
  limit: number
  windowMs: number
  now?: () => number
}): Limiter {
  const now = options.now ?? Date.now
  const hits = new Map<string, number[]>()
  return {
    take(key) {
      const at = now()
      const live = (hits.get(key) ?? []).filter((t) => at - t < options.windowMs)
      if (live.length >= options.limit) {
        hits.set(key, live)
        return Math.max(1, Math.ceil(((live[0] as number) + options.windowMs - at) / 1000))
      }
      live.push(at)
      hits.delete(key)
      hits.set(key, live)
      if (hits.size > MAX_KEYS) {
        // evict the least recently used key
        const oldest = hits.keys().next().value
        if (oldest !== undefined) hits.delete(oldest)
      }
      return undefined
    },
  }
}
