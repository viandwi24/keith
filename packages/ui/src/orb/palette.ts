import { PALETTES, type ThemeName, type Token } from '../tokens.ts'
import type { BrainColors } from './brain-trace.ts'
import { fade, hexToRgb, type Rgb } from './color.ts'
import type { FrameColors } from './frame-text.ts'
import type { OrbColors } from './orb.ts'

export interface OrbPaletteColors {
  background: Rgb
  orb: OrbColors
  brain: BrainColors
  frame: FrameColors
  text: Rgb
  muted: Rgb
}

/**
 * The orb's colours from the theme tokens (hex in the palette). `k` below 1 blends every colour toward the background (a
 * `Reveal` fading in); the Ink hook and the web both read it, so the two orbs share one source.
 */
export function orbPaletteOf(name: ThemeName, k = 1): OrbPaletteColors {
  const p = PALETTES[name]
  const bg = hexToRgb(p.bg.hex)
  const rgb = (t: Token): Rgb => (k >= 1 ? hexToRgb(p[t].hex) : fade(hexToRgb(p[t].hex), k, bg))
  return {
    background: bg,
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
}
