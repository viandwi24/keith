// The workspace's keyboard shortcuts (P40.4, docs/specs/web.md "Workspace"), as a pure map from a key event to an action. Every
// shortcut holds Alt (Option on a Mac) and reads `code`, not `key`: Option+letter types a special character on a Mac, the code
// stays the same. Arrows are left to a text field (Option+Arrow moves by word there).

import { type Desktop, focusedOf, MAX_DESKTOPS, type WorkspaceDoc } from './model.ts'

export type KeyAction =
  | { kind: 'desktop'; index: number }
  | { kind: 'desktop-step'; step: 1 | -1 }
  | { kind: 'desktop-move'; step: 1 | -1 }
  | { kind: 'window-cycle'; step: 1 | -1 }
  | { kind: 'overview' }
  | { kind: 'close-window' }
  | { kind: 'new-desktop' }
  | { kind: 'ambient' }

export interface KeyInput {
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  /** The event comes from a text field, a text area or an editable element. */
  editable: boolean
}

/** The shortcuts as the help lists them. */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: `Alt+1…${MAX_DESKTOPS}`, does: 'Show that desktop' },
  { keys: 'Alt+← / Alt+→', does: 'Previous / next desktop' },
  { keys: 'Alt+Shift+← / →', does: 'Move the desktop left / right' },
  { keys: 'Alt+J / Alt+K', does: 'Next / previous window' },
  { keys: 'Alt+O', does: 'Overview' },
  { keys: 'Alt+W', does: 'Close the focused window' },
  { keys: 'Alt+N', does: 'New desktop' },
  { keys: 'Alt+H', does: 'Back to the orb' },
]

export function keyAction(e: KeyInput): KeyAction | undefined {
  if (!e.altKey || e.ctrlKey || e.metaKey) return undefined
  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit !== null && !e.shiftKey) {
    const index = Number(digit[1]) - 1
    return index < MAX_DESKTOPS ? { kind: 'desktop', index } : undefined
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (e.editable) return undefined
    const step = e.code === 'ArrowLeft' ? -1 : 1
    return e.shiftKey ? { kind: 'desktop-move', step } : { kind: 'desktop-step', step }
  }
  if (e.shiftKey) return undefined
  switch (e.code) {
    case 'KeyJ':
      return { kind: 'window-cycle', step: 1 }
    case 'KeyK':
      return { kind: 'window-cycle', step: -1 }
    case 'KeyO':
      return { kind: 'overview' }
    case 'KeyW':
      return { kind: 'close-window' }
    case 'KeyN':
      return { kind: 'new-desktop' }
    case 'KeyH':
      return { kind: 'ambient' }
    default:
      return undefined
  }
}

/** The desktop `step` away from `desktopId`, wrapping around. */
export function stepDesktop(doc: WorkspaceDoc, desktopId: string, step: 1 | -1): string {
  const n = doc.desktops.length
  const at = Math.max(
    0,
    doc.desktops.findIndex((d) => d.id === desktopId),
  )
  return (doc.desktops[(at + step + n) % n] as Desktop).id
}

/** The index a desktop moves to one step left or right, or undefined at the edge. */
export function movedIndex(doc: WorkspaceDoc, desktopId: string, step: 1 | -1): number | undefined {
  const at = doc.desktops.findIndex((d) => d.id === desktopId)
  const to = at + step
  return at < 0 || to < 0 || to >= doc.desktops.length ? undefined : to
}

/** The window to focus next when cycling (minimised ones too: focusing restores them), or undefined with fewer than two. */
export function cycleWindow(desktop: Desktop, step: 1 | -1): string | undefined {
  const n = desktop.windows.length
  if (n < 2) return undefined
  const top = focusedOf(desktop)
  const at = top === undefined ? 0 : desktop.windows.findIndex((w) => w.id === top.id)
  return desktop.windows[(at + step + n) % n]?.id
}
