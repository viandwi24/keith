import { useMemo } from 'react'
import type { BrainColors } from './orb/brain-trace.ts'
import type { ColorEnv, Rgb } from './orb/color.ts'
import type { FrameColors } from './orb/frame-text.ts'
import type { OrbColors } from './orb/orb.ts'
import { orbPaletteOf } from './orb/palette.ts'
import { useFadeLevel, useTheme } from './theme-context.tsx'

export interface OrbPalette {
  env: ColorEnv
  orb: OrbColors
  brain: BrainColors
  frame: FrameColors
  text: Rgb
  muted: Rgb
}

/**
 * The orb's colours from the theme tokens (hex in the palette, quantised later by the depth). Under
 * a `Reveal` they are blended toward the background by its level; `faded: false` keeps the full
 * colours (the orb itself, which applies the level to what it draws).
 */
export function useOrbPalette({ faded = true }: { faded?: boolean } = {}): OrbPalette {
  const theme = useTheme()
  const level = useFadeLevel()
  const k = faded ? level : 1
  return useMemo(() => {
    const { background, ...colors } = orbPaletteOf(theme.name, k)
    return { env: { depth: theme.depth, background }, ...colors }
  }, [theme, k])
}
