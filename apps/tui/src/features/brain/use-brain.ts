import type { BrainEvent } from '@keith/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type BrainState,
  FADE_MS,
  initialBrain,
  type RegionView,
  reduceBrain,
  resyncBrain,
  viewKey,
  viewOf,
} from './brain-state.ts'

export interface BrainTuning {
  /** How long a region stays lit. Default 1500 ms. */
  fadeMs?: number
  /** Render period: the panel re-renders at most this often. Default 100 ms. */
  tickMs?: number
}

export interface BrainSnapshot {
  state: BrainState
  view: RegionView[]
}

export interface Brain extends BrainSnapshot {
  /** Feed one brain event (does not render by itself; the next tick does). */
  push(event: BrainEvent): void
  /** The feed resynced: forget a dream run that may have ended while the link was down. */
  resync(): void
}

/**
 * Brain state fed by events. Events only touch a ref; a timer samples it every `tickMs` and
 * re-renders when the visible result (lamps, last line) changed. That throttles bursts of events
 * and also fades regions out, with no timer per event.
 */
export function useBrain({ fadeMs = FADE_MS, tickMs = 100 }: BrainTuning = {}): Brain {
  const ref = useRef<BrainState>(initialBrain)
  const snapshot = (): BrainSnapshot => ({
    state: ref.current,
    view: viewOf(ref.current, Date.now(), fadeMs),
  })
  const [snap, setSnap] = useState<BrainSnapshot>(snapshot)
  const shown = useRef(snap)
  shown.current = snap
  useEffect(() => {
    const timer = setInterval(() => {
      const next = snapshot()
      const prev = shown.current
      if (
        next.state !== prev.state ||
        viewKey(next.view, undefined) !== viewKey(prev.view, undefined)
      )
        setSnap(next)
    }, tickMs)
    return () => clearInterval(timer)
  }, [tickMs, fadeMs])
  const push = useCallback((event: BrainEvent) => {
    ref.current = reduceBrain(ref.current, event, Date.now())
  }, [])
  const resync = useCallback(() => {
    ref.current = resyncBrain(ref.current)
  }, [])
  return { ...snap, push, resync }
}
