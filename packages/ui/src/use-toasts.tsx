import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { canFade } from './blend.ts'
import { useMotion } from './motion-context.tsx'
import { useTheme } from './theme-context.tsx'
import { FADE_MS } from './use-fade.ts'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: number
  level: ToastLevel
  text: string
  /** The toast is on its way out: the stack fades it, then it is removed. */
  leaving: boolean
}

export interface ToastOptions {
  level?: ToastLevel
  /** How long it stays before it fades (default 5000 ms). */
  ms?: number
}

export const TOAST_MS = 5000
/** The most toasts on screen: a new one beyond it drops the oldest. */
export const TOAST_MAX = 3

interface ToastApi {
  push(text: string, options?: ToastOptions): number
  dismiss(id: number): void
}

const Items = createContext<readonly ToastItem[]>([])
const Api = createContext<ToastApi>({ push: () => 0, dismiss: () => {} })

/**
 * Owns the toasts and their timers. Each toast lives `ms`, fades for `FADE_MS`, then is removed; where
 * nothing can fade (none or 16 colours, reduced motion) it is removed at `ms`. Time comes from the
 * `MotionProvider` scheduler. With no toast there is no timer; every timer is cleared on unmount.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { depth } = useTheme()
  const { scheduler, reduced } = useMotion()
  const fades = !reduced && canFade(depth)
  const [items, setItems] = useState<readonly ToastItem[]>([])
  const timers = useRef(new Map<number, Array<() => void>>())
  const nextId = useRef(1)
  const fadesRef = useRef(fades)
  fadesRef.current = fades

  const forget = useCallback((id: number) => {
    for (const stop of timers.current.get(id) ?? []) stop()
    timers.current.delete(id)
  }, [])
  const remove = useCallback(
    (id: number) => {
      forget(id)
      setItems((all) => all.filter((t) => t.id !== id))
    },
    [forget],
  )
  const push = useCallback(
    (text: string, { level = 'info', ms = TOAST_MS }: ToastOptions = {}) => {
      const id = nextId.current++
      setItems((all) => {
        const next = [...all, { id, level, text, leaving: false }]
        for (const dropped of next.slice(0, Math.max(0, next.length - TOAST_MAX)))
          forget(dropped.id)
        return next.slice(-TOAST_MAX)
      })
      const stops: Array<() => void> = []
      if (fadesRef.current) {
        stops.push(
          scheduler.after(ms, () =>
            setItems((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t))),
          ),
        )
        stops.push(scheduler.after(ms + FADE_MS, () => remove(id)))
      } else stops.push(scheduler.after(ms, () => remove(id)))
      timers.current.set(id, stops)
      return id
    },
    [scheduler, forget, remove],
  )
  useEffect(() => {
    const all = timers.current
    return () => {
      for (const stops of all.values()) for (const stop of stops) stop()
      all.clear()
    }
  }, [])
  const api = useMemo(() => ({ push, dismiss: remove }), [push, remove])
  return (
    <Api.Provider value={api}>
      <Items.Provider value={items}>{children}</Items.Provider>
    </Api.Provider>
  )
}

/** `push(text, { level, ms })` shows a toast; the returned id goes to `dismiss`. Without a provider it does nothing. */
export const useToast = (): ToastApi => useContext(Api)
export const useToastItems = (): readonly ToastItem[] => useContext(Items)
