import {
  applyThemeMode,
  effectiveTheme,
  readThemeMode,
  type ThemeMode,
  writeThemeMode,
} from './theme.ts'

/** The theme mode the person chose and the theme on screen (the orb canvas reads `name`). */
class ThemeState {
  mode = $state<ThemeMode>(readThemeMode())
  prefersLight = $state(false)
  name = $derived(effectiveTheme(this.mode, this.prefersLight))

  /** Follow the browser's colour scheme; returns the stop function. */
  watch(): () => void {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: light)')
    if (query === undefined) return () => undefined
    this.prefersLight = query.matches
    const onChange = (event: MediaQueryListEvent): void => {
      this.prefersLight = event.matches
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }

  set(mode: ThemeMode): void {
    this.mode = mode
    writeThemeMode(mode)
    applyThemeMode(document.documentElement, mode)
  }

  /** Dark, then light, then system, as the palette's "Theme" action cycles. */
  cycle(): void {
    this.set(this.mode === 'system' ? 'dark' : this.mode === 'dark' ? 'light' : 'system')
  }
}

export const theme = new ThemeState()
