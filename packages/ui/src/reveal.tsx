import type { ReactNode } from 'react'
import { fadeTheme } from './blend.ts'
import { ThemeOverride, useTheme } from './theme-context.tsx'
import { type FadeOptions, useFade } from './use-fade.ts'

export interface RevealProps extends FadeOptions {
  children: ReactNode
}

/**
 * Fades its children in or out: while `visible` flips, the colours move between the background and
 * their own value through theme tokens. At level 0 nothing is drawn (the children unmount, so their
 * timers stop); at 1 the children render untouched; with no colour (none depth) there is no fade
 * and never a colour prop. Put it around parts whose size does not depend on being drawn.
 */
export function Reveal({ children, ...fade }: RevealProps) {
  const theme = useTheme()
  const level = useFade(fade)
  if (level <= 0) return null
  if (level >= 1) return <>{children}</>
  return (
    <ThemeOverride theme={fadeTheme(theme, level)} fade={level}>
      {children}
    </ThemeOverride>
  )
}
