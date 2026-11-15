// Browser key events as terminal bytes (docs/specs/plugin-views.md, "Web"): the event is mapped to the shape `keyBytes` of
// `@keith/client` reads (the TUI's mapping), so both clients send the same bytes for the same key. Pure.
import { type KeyLike, keyBytes } from '@keith/client/browser'

/** The part of a `KeyboardEvent` read here. */
export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing?: boolean
  /** `getModifierState('AltGraph')`: a character typed with AltGr is text, not a chord. */
  altGraph?: boolean
}

const NAMED: Record<string, keyof KeyLike> = {
  ArrowUp: 'upArrow',
  ArrowDown: 'downArrow',
  ArrowLeft: 'leftArrow',
  ArrowRight: 'rightArrow',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Home: 'home',
  End: 'end',
  Enter: 'return',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
}

const blank = (): KeyLike => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
})

/** The `(input, key)` pair of a key event, or `undefined` for one the view never gets (a lone modifier, F-keys, a command chord, IME text). */
export function keyLikeOf(e: KeyEventLike): { input: string; key: KeyLike } | undefined {
  // Cmd and Win belong to the browser and the system; composition text arrives through the IME, not as keys
  if (e.metaKey || e.isComposing === true) return undefined
  const key = blank()
  const named = NAMED[e.key]
  if (named !== undefined) {
    key[named] = true
    key.shift = e.shiftKey
    key.ctrl = e.ctrlKey
    key.meta = e.altKey
    return { input: '', key }
  }
  if ([...e.key].length !== 1) return undefined
  const text = e.altGraph === true
  key.ctrl = e.ctrlKey && !text
  key.meta = e.altKey && !text
  let input = e.key
  // alt+letter on a Mac types a symbol: the physical key is what the program expects (`ESC f`)
  if (key.meta && /^Key[A-Z]$/.test(e.code ?? '')) input = (e.code as string).slice(3).toLowerCase()
  return { input, key }
}

/** The terminal bytes of a key event, or `undefined` when nothing is sent (the page keeps the event). */
export function terminalBytesOf(e: KeyEventLike): string | undefined {
  const pair = keyLikeOf(e)
  return pair === undefined ? undefined : keyBytes(pair.input, pair.key)
}

/** `esc` hands the keyboard back to the page (the grid takes Tab, so the keys must have a way out). */
export const releasesFocus = (e: KeyEventLike): boolean => e.key === 'Escape' && !e.metaKey
