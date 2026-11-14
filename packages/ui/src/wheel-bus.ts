/** Lines one wheel notch scrolls (the feel of terminal coding agents). */
export const WHEEL_LINES = 3

type Listener = (lines: number) => void

const listeners = new Set<Listener>()

/**
 * Ink has no mouse API: the app reads wheel events itself and sends them here. Every mounted,
 * active `ScrollView` listens; `lines` is negative to scroll up (toward older rows), positive down.
 */
export function emitWheel(lines: number): void {
  for (const listener of [...listeners]) listener(lines)
}

/** Listen to wheel events; returns the function that stops listening. */
export function onWheel(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
