import { useEffect, useRef, useState } from 'react'
import { canFade, FADE_STEPS, stepOf } from './blend.ts'
import { useMotion } from './motion-context.tsx'
import { useTheme } from './theme-context.tsx'

export interface FadeOptions {
  /** Where the fade goes: `true` in (level 1), `false` out (level 0). */
  visible: boolean
  /** Level at mount (default: already at `visible`'s end, so nothing animates until it changes). */
  from?: number
  /** Length of a full fade (default 300 ms). */
  durationMs?: number
  /** Wait before the fade starts (stages of an intro). */
  delayMs?: number
  /** Jump to the end now (a key skipped the intro). */
  instant?: boolean
}

export const FADE_MS = 300
/** The shortest period of the timer: a terminal cannot show more than ~30 changes a second. */
const MIN_TICK_MS = 33

/**
 * The level (0..1) of a fade, snapped to the steps of the colour depth, so a render happens only
 * when the colour changes. With no fade to show (none or 16 colours, reduced motion, `instant`) it
 * switches at once and no timer exists. The timer runs only while a fade is under way: it is
 * cleared the tick the level arrives and on unmount.
 */
export function useFade({
  visible,
  from,
  durationMs = FADE_MS,
  delayMs = 0,
  instant = false,
}: FadeOptions): number {
  const { depth } = useTheme()
  const { scheduler, reduced } = useMotion()
  const target = visible ? 1 : 0
  const still = instant || reduced || !canFade(depth) || durationMs <= 0
  const [level, setLevel] = useState(() => (still ? target : stepOf(from ?? target, depth)))
  const current = useRef(level)
  current.current = level
  useEffect(() => {
    if (still) {
      current.current = target
      setLevel(target)
      return undefined
    }
    const start = scheduler.now() + delayMs
    const origin = current.current
    if (origin === target) return undefined
    const stop = scheduler.every(Math.max(MIN_TICK_MS, durationMs / FADE_STEPS[depth]), () => {
      const t = (scheduler.now() - start) / durationMs
      if (t <= 0) return
      const next = stepOf(origin + (target - origin) * Math.min(1, t), depth)
      setLevel(next)
      if (t >= 1) stop()
    })
    return stop
  }, [target, still, depth, durationMs, delayMs, scheduler])
  return level
}
