import { createContext, type ReactNode, useContext } from 'react'

/** Time for an animation: injectable so tests step it by hand (`@keith/ui/testing`) instead of sleeping. */
export interface Scheduler {
  /** Milliseconds on a monotonic clock. */
  now(): number
  /** Call `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void
  /** Call `fn` once after `ms`, unless the returned function is called first. */
  after(ms: number, fn: () => void): () => void
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  every(ms, fn) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  after(ms, fn) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

export interface MotionValue {
  scheduler: Scheduler
  /** Reduced motion: fades and the intro are skipped, states still switch (instantly). */
  reduced: boolean
  /**
   * The orb is still (`--disable-orb`): one fixed frame, drawn in the colour of its state. No timer, no waves,
   * no flight between screens. Only its colour changes.
   */
  orbStatic: boolean
}

const DEFAULT: MotionValue = { scheduler: realScheduler, reduced: false, orbStatic: false }
const Context = createContext<MotionValue>(DEFAULT)

export function MotionProvider({
  scheduler = realScheduler,
  reduced = false,
  orbStatic = false,
  children,
}: {
  scheduler?: Scheduler
  reduced?: boolean
  orbStatic?: boolean
  children: ReactNode
}) {
  return <Context.Provider value={{ scheduler, reduced, orbStatic }}>{children}</Context.Provider>
}

export const useMotion = (): MotionValue => useContext(Context)
