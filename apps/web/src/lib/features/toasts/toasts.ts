import { G } from '@keith/ui/tokens'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  text: string
  level: ToastLevel
  /** How long it stays, in ms. */
  ms: number
  /** An optional link under the text (`Confirm in the Inbox`). */
  link?: { href: string; label: string }
}

/** A toast stays 5 s by default and at most three show at once, newest last (tui-design 5.20). */
export const TOAST_MS = 5000
export const TOAST_MAX = 3

/** Level glyphs of the TUI toast: `·` info, `✓` success, `!` warning, `✕` error. */
export const TOAST_GLYPH: Record<ToastLevel, string> = {
  info: G.sep,
  success: G.done,
  warning: G.warn,
  error: G.failed,
}

/** The list after a push: the new toast last; a fourth drops the oldest at once. */
export function withToast(list: readonly Toast[], toast: Toast): Toast[] {
  return [...list, toast].slice(-TOAST_MAX)
}

export const withoutToast = (list: readonly Toast[], id: number): Toast[] =>
  list.filter((t) => t.id !== id)
