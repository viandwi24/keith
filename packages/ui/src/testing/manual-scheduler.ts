import type { Scheduler } from '../motion-context.tsx'

export interface ManualScheduler extends Scheduler {
  /** Move time forward, running every timer that falls due, in order. */
  advance(ms: number): void
  /** Timers still running (a finished fade must leave none). */
  active(): number
}

/** A scheduler driven by hand: tests step time instead of sleeping. */
export function manualScheduler(): ManualScheduler {
  let time = 0
  let nextId = 0
  const timers = new Map<number, { ms: number; due: number; fn: () => void }>()
  return {
    now: () => time,
    every(ms, fn) {
      const id = nextId++
      timers.set(id, { ms, due: time + ms, fn })
      return () => {
        timers.delete(id)
      }
    },
    after(ms, fn) {
      const id = nextId++
      timers.set(id, {
        ms: Number.POSITIVE_INFINITY,
        due: time + ms,
        fn: () => {
          timers.delete(id)
          fn()
        },
      })
      return () => {
        timers.delete(id)
      }
    },
    advance(ms) {
      const end = time + ms
      for (;;) {
        let first: { ms: number; due: number; fn: () => void } | undefined
        for (const t of timers.values())
          if (t.due <= end && (!first || t.due < first.due)) first = t
        if (!first) break
        time = first.due
        first.due += first.ms
        first.fn()
      }
      time = end
    },
    active: () => timers.size,
  }
}
