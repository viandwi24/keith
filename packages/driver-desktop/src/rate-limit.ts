// A sliding one-minute window over desktop actions (`maxActionsPerMinute`).

const WINDOW_MS = 60_000

export class RateLimiter {
  private readonly events: { at: number; cost: number }[] = []

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  /** Spends `cost` actions when the window has room; returns false and spends nothing otherwise. */
  take(cost: number): boolean {
    const at = this.now()
    while (this.events.length > 0 && (this.events[0]?.at ?? 0) <= at - WINDOW_MS) {
      this.events.shift()
    }
    const used = this.events.reduce((sum, event) => sum + event.cost, 0)
    if (used + cost > this.perMinute) return false
    this.events.push({ at, cost })
    return true
  }
}
