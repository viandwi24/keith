import { homedir } from 'node:os'
import type { Hint } from '@keith/ui'

// priority: what stays when the legend is too narrow (higher stays longer; `/help` is always kept)
/** The newline hint only names a key that works: `shift+enter` where the terminal reports it, else `ctrl+j`. */
export const newlineHint = (kitty: boolean): Hint => ({
  key: kitty ? 'shift+enter' : 'ctrl+j',
  action: 'newline',
  priority: 40,
})
/** Idle: `esc` goes Home (`ctrl+g` does too, but is not repeated here). */
export const chatIdle = (kitty: boolean): readonly Hint[] => [
  { key: 'enter', action: 'send', priority: 80 },
  newlineHint(kitty),
  { key: 'ctrl+b', action: 'sidebar', priority: 20 },
  { key: 'esc', action: 'home', priority: 70 },
  { key: '/help', action: '' },
]
/** Busy: `esc` stops the turn and `ctrl+g` goes Home without stopping it. */
export const CHAT_BUSY: readonly Hint[] = [
  { key: 'esc', action: 'stop', priority: 90 },
  { key: 'ctrl+g', action: 'home', priority: 80 },
  { key: 'ctrl+b', action: 'sidebar', priority: 20 },
]
/** `~/.keith/core.sock` instead of the absolute path of the home directory. */
export const shorten = (target: string): string => {
  const home = homedir()
  return home !== '' && target.includes(home) ? target.replace(home, '~') : target
}

export interface HintsInput {
  /** The step-up prompt is open: its own row lists its keys. */
  stepUpOpen: boolean
  /** The approval dialog owns the keys: its own row lists them. */
  barHasKeys: boolean
  /** Signed out, core down, or whoami not answered yet. */
  notReady: boolean
  approvalsWaiting: boolean
  chatBusy: boolean
  /** The terminal reports `shift+enter` (Kitty keyboard protocol). */
  kitty?: boolean
}

/**
 * The key hints the chat's footer (or the rule above the input) shows when no screen set its own.
 * While a dialog has the keys the page says nothing: the dialog's own legend row is the one place
 * its keys are listed (tui-design 5.7), so they never appear twice.
 */
export function hintsOf({
  stepUpOpen,
  barHasKeys,
  notReady,
  approvalsWaiting,
  chatBusy,
  kitty = false,
}: HintsInput): readonly Hint[] {
  if (stepUpOpen || barHasKeys) return []
  if (notReady) return [{ key: 'ctrl+c', action: 'quit' }]
  return [
    ...(approvalsWaiting ? ([{ key: 'tab', action: 'approval', tone: 'warning' }] as const) : []),
    ...(chatBusy ? CHAT_BUSY : chatIdle(kitty)),
  ]
}
