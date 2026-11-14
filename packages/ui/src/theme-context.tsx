import { createContext, type ReactNode, useContext } from 'react'
import { resolveTheme, type Theme } from './theme.ts'

interface ThemeValue {
  theme: Theme
  /** Animated spinner on (off in none depth and in tests: the spinner is the static `◐`). */
  spinner: boolean
  /** How far a `Reveal` has faded this subtree in (1 = fully shown): the orb and its glyphs read it. */
  fade: number
}

/** Without a provider: dark, no colour, no animation (what the tests render). */
const DEFAULT: ThemeValue = {
  theme: resolveTheme({ theme: 'dark', depth: 'none' }),
  spinner: false,
  fade: 1,
}

const Context = createContext<ThemeValue>(DEFAULT)

export function ThemeProvider({
  theme,
  spinner = false,
  children,
}: {
  theme: Theme
  spinner?: boolean
  children: ReactNode
}) {
  return <Context.Provider value={{ theme, spinner, fade: 1 }}>{children}</Context.Provider>
}

export const useTheme = (): Theme => useContext(Context).theme
export const useFadeLevel = (): number => useContext(Context).fade
export const useSpinnerEnabled = (): boolean => {
  const { theme, spinner } = useContext(Context)
  return spinner && theme.depth !== 'none'
}

/** The same spinner setting under a faded theme (what `Reveal` passes down) and its level. */
export function ThemeOverride({
  theme,
  fade,
  children,
}: {
  theme: Theme
  fade: number
  children: ReactNode
}) {
  const { spinner } = useContext(Context)
  return <Context.Provider value={{ theme, spinner, fade }}>{children}</Context.Provider>
}
