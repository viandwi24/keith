import { useEffect, useRef, useState } from 'react'

export const DEFAULT_FPS = 12
export const MAX_FPS = 30

export interface FrameClock {
  /** Counts up one per frame; changes exactly when a new frame is due. */
  tick: number
  /** Seconds since the previous frame (0 before the first). */
  dt: number
}

export interface FrameClockOptions {
  /** Frames per second, capped at MAX_FPS and at least 1 (default 12). */
  fps?: number
  /** `false` stops the timer: the clock holds its last value and costs nothing. */
  running?: boolean
}

/** One interval timer for an animation. Share the result (`clock` props) so a screen has one timer. */
export function useFrameClock({
  fps = DEFAULT_FPS,
  running = true,
}: FrameClockOptions = {}): FrameClock {
  const [clock, setClock] = useState<FrameClock>({ tick: 0, dt: 0 })
  const last = useRef<number | undefined>(undefined)
  const rate = Math.max(1, Math.min(MAX_FPS, fps))
  useEffect(() => {
    if (!running) {
      last.current = undefined
      return undefined
    }
    const timer = setInterval(() => {
      const now = performance.now()
      const dt = last.current === undefined ? 0 : (now - last.current) / 1000
      last.current = now
      setClock((c) => ({ tick: c.tick + 1, dt }))
    }, 1000 / rate)
    return () => clearInterval(timer)
  }, [running, rate])
  return clock
}
