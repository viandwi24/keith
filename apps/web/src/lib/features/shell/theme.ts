export type ThemeMode = 'system' | 'dark' | 'light'

export const THEME_MODES: readonly ThemeMode[] = ['system', 'dark', 'light']
const KEY = 'keith.theme'

export const parseThemeMode = (value: unknown): ThemeMode =>
  value === 'dark' || value === 'light' ? value : 'system'

/** `system` removes the override (the media query decides); `dark` and `light` set `data-theme`. */
export function applyThemeMode(root: HTMLElement, mode: ThemeMode): void {
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

/** The remembered choice; storage can be blocked, so every access is guarded and `system` is the fallback. */
export function readThemeMode(): ThemeMode {
  try {
    return parseThemeMode(globalThis.localStorage?.getItem(KEY))
  } catch {
    return 'system'
  }
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') globalThis.localStorage?.removeItem(KEY)
    else globalThis.localStorage?.setItem(KEY, mode)
  } catch {
    // the choice then lasts until the tab closes
  }
}

/** The theme that is on screen: an override wins, `system` follows the browser's colour scheme. */
export const effectiveTheme = (mode: ThemeMode, prefersLight: boolean): 'dark' | 'light' =>
  mode === 'system' ? (prefersLight ? 'light' : 'dark') : mode
