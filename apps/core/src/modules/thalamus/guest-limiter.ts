/**
 * The per-IP window of guest session starts (docs/specs/guests.md): at most `max` attempts per `windowMs` for one
 * keyed address hash. Memory only. Each attempt that gets past the zone check counts, allowed or not, so a client
 * that hammers the entry cannot make the owner-side checks run for free.
 */
export interface StartLimiter {
  /** Records an attempt. `retryAfterMs` is set when it is over the limit. */
  take(key: string): { allowed: true } | { allowed: false; retryAfterMs: number }
  /** Drop windows with no recent attempt (the listener calls it now and then). */
  sweep(): void
  readonly size: number
}

const MAX_KEYS = 10_000

export function createStartLimiter(options: {
  max: () => number
  windowMs: number
  now?: () => number
}): StartLimiter {
  const now = options.now ?? Date.now
  const attempts = new Map<string, number[]>()
  const fresh = (list: number[], at: number): number[] =>
    list.filter((t) => at - t < options.windowMs)
  const sweep = (): void => {
    const at = now()
    for (const [key, list] of attempts) {
      const recent = fresh(list, at)
      if (recent.length === 0) attempts.delete(key)
      else attempts.set(key, recent)
    }
  }
  return {
    take(key) {
      const at = now()
      if (attempts.size >= MAX_KEYS && !attempts.has(key)) {
        // a flood of distinct addresses: forget the quiet ones; if it is still full, answer "slow down"
        sweep()
        if (attempts.size >= MAX_KEYS) return { allowed: false, retryAfterMs: options.windowMs }
      }
      const recent = fresh(attempts.get(key) ?? [], at)
      if (recent.length >= options.max()) {
        attempts.set(key, recent)
        const oldest = recent[0] ?? at
        return { allowed: false, retryAfterMs: Math.max(1000, oldest + options.windowMs - at) }
      }
      recent.push(at)
      attempts.set(key, recent)
      return { allowed: true }
    },
    sweep,
    get size() {
      return attempts.size
    },
  }
}
