import type { Scheduler } from '@keith/ui'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface VeilOptions {
  /** Seconds without activity before the veil closes; 0 never hides. */
  idleSeconds: number
  /** Something needs the person (an approval, a dialog, a login panel, an error): never hidden, timer reset. */
  blocked: boolean
  scheduler: Scheduler
}

/**
 * The idle veil of Home: `hidden` turns true after `idleSeconds` without a key and back to false on
 * the next one. `touch()` is called for every key: it re-arms the one timer and answers `true` when
 * that key woke a hidden screen (the caller then swallows it). There is exactly one pending
 * one-shot timer while Home is shown and unblocked, none while hidden or blocked.
 */
export function useHomeVeil({ idleSeconds, blocked, scheduler }: VeilOptions) {
  const [hidden, setHidden] = useState(false)
  const hiddenRef = useRef(false)
  const cancel = useRef<(() => void) | undefined>(undefined)
  const show = useCallback(() => {
    hiddenRef.current = false
    setHidden(false)
  }, [])
  const arm = useCallback(() => {
    cancel.current?.()
    cancel.current = undefined
    if (idleSeconds <= 0 || blocked) return
    cancel.current = scheduler.after(idleSeconds * 1000, () => {
      cancel.current = undefined
      hiddenRef.current = true
      setHidden(true)
    })
  }, [idleSeconds, blocked, scheduler])
  useEffect(() => {
    if ((blocked || idleSeconds <= 0) && hiddenRef.current) show()
    arm()
    return () => {
      cancel.current?.()
      cancel.current = undefined
    }
  }, [arm, blocked, idleSeconds, show])
  const touch = useCallback((): boolean => {
    const woke = hiddenRef.current
    if (woke) show()
    arm()
    return woke
  }, [arm, show])
  return { hidden, touch }
}
