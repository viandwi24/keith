import { useMemo } from 'react'
import type { BrainColors } from './orb/brain-trace.ts'
import { type ColorEnv, fade, hexToRgb, type Rgb } from './orb/color.ts'
import type { FrameColors } from './orb/frame-text.ts'
import type { OrbColors } from './orb/orb.ts'
import { PALETTES, type Token } from './theme.ts'
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
    const p = PALETTES[theme.name]
    const bg = hexToRgb(p.bg.hex)
    const rgb = (t: Token): Rgb => (k >= 1 ? hexToRgb(p[t].hex) : fade(hexToRgb(p[t].hex), k, bg))
    return {
      env: { depth: theme.depth, background: bg },
      orb: {
        idle: rgb('orb-idle'),
        listening: rgb('success'),
        thinking: rgb('orb-thinking'),
        speaking: rgb('orb-speaking'),
        alert: rgb('danger'),
      },
      brain: {
        regions: {
          thalamus: rgb('info'),
          wernicke: rgb('region-wernicke'),
          broca: rgb('warning'),
          cortex: rgb('text'),
          motor: rgb('success'),
          amygdala: rgb('danger'),
          ras: rgb('text-muted'),
          hippocampus: rgb('region-hippocampus'),
          parietal: rgb('region-parietal'),
          hypothalamus: rgb('region-hypothalamus'),
          'corpus-callosum': rgb('region-corpus-callosum'),
          prefrontal: rgb('region-prefrontal'),
        },
        muted: rgb('text-muted'),
      },
      frame: { border: rgb('border'), text: rgb('text'), accent: rgb('accent') },
      text: rgb('text'),
      muted: rgb('text-muted'),
    }
  }, [theme, k])
}
