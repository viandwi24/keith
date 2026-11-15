/**
 * The part of a key event `keyBytes` reads. Ink's `Key` fits it as it is; the web client fills it from a `KeyboardEvent`
 * (`apps/web`, `features/apps/key-map.ts`). `meta` is the alt key.
 */
export interface KeyLike {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
}
type Key = KeyLike

const ESC = '\u001b'

/** What `esc` and `ctrl+g` do on a view panel: the panel keeps them, the view never sees them. */
export const isLeave = (key: Key): boolean => key.escape
export const isHome = (input: string, key: Key): boolean => key.ctrl && input === 'g'

/** xterm modifier parameter: 1 + shift 1 + alt 2 + ctrl 4. */
const modifier = (key: Key): number =>
  1 + (key.shift ? 1 : 0) + (key.meta ? 2 : 0) + (key.ctrl ? 4 : 0)

/** C0 controls (but tab, newline, return) and C1 controls: a paste is text, never a way to inject a sequence. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the filter
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * The terminal bytes of a key event, as a program reading a raw terminal would get them (an arrow up is `ESC [ A`), or
 * `undefined` when the key is not sent: `esc` and `ctrl+g` belong to the panel and `ctrl+c` to the app's own exit.
 * The view sees an ordinary terminal's input, nothing more: no mouse, no focus events, no Kitty protocol.
 */
export function keyBytes(input: string, key: Key): string | undefined {
  if (key.escape || (key.ctrl && (input === 'g' || input === 'c'))) return undefined
  const mod = modifier(key)
  const csi = (final: string): string => (mod > 1 ? `${ESC}[1;${mod}${final}` : `${ESC}[${final}`)
  const tilde = (code: number): string => (mod > 1 ? `${ESC}[${code};${mod}~` : `${ESC}[${code}~`)
  if (key.upArrow) return csi('A')
  if (key.downArrow) return csi('B')
  if (key.rightArrow) return csi('C')
  if (key.leftArrow) return csi('D')
  if (key.home) return csi('H')
  if (key.end) return csi('F')
  if (key.pageUp) return tilde(5)
  if (key.pageDown) return tilde(6)
  if (key.delete) return tilde(3)
  if (key.return) return key.meta ? `${ESC}\r` : '\r'
  if (key.tab) return key.shift ? `${ESC}[Z` : '\t'
  if (key.backspace) return key.meta ? `${ESC}\u007f` : '\u007f'
  if (key.ctrl) {
    // ctrl+a to ctrl+z are the control codes 1 to 26
    const code = input.length === 1 ? input.toLowerCase().charCodeAt(0) : 0
    return code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : undefined
  }
  const text = input.replace(CONTROLS, '')
  if (text === '') return undefined
  return key.meta ? `${ESC}${text}` : text
}
