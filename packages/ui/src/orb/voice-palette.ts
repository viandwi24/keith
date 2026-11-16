import type { BrainColors } from './brain-trace.ts'
import { hexToRgb } from './color.ts'
import type { OrbColors } from './orb.ts'
import { orbPaletteOf } from './palette.ts'

// The voice orb's own look (the "KEITH voice orb" design and its HUD panels): always dark, whatever the theme. The web's full-screen
// stage reads it; the colours live here so the web keeps no colour literal (apps/web/AGENTS.md).

/** A HUD panel: near-black fill, a hairline border, white corner brackets, a dashed rule under the title. */
export interface HudPanelColors {
  fill: string
  border: string
  bracket: string
  rule: string
  title: string
  text: string
  muted: string
}

export interface VoiceOrbPalette {
  /** The page: near black, a lighter centre fading to the edge, faint scanlines. */
  background: string
  backgroundCentre: string
  backgroundEdge: string
  scanline: string
  /** The wordmark under the orb. */
  label: string
  orb: OrbColors
  panel: HudPanelColors
  /** The brain trace: the terminal's dark-theme region colours, so a region reads the same in both clients. */
  brain: BrainColors
}

export const VOICE_ORB_PALETTE: VoiceOrbPalette = {
  background: '#030303',
  backgroundCentre: '#0e0e0e',
  backgroundEdge: '#020202',
  scanline: 'rgba(255, 255, 255, 0.018)',
  label: '#ffffff',
  orb: {
    idle: hexToRgb('#d4d4d4'),
    listening: hexToRgb('#4ade80'),
    thinking: hexToRgb('#a5b4fc'),
    speaking: hexToRgb('#ffffff'),
    alert: hexToRgb('#f87171'),
  },
  panel: {
    // translucent: the panels float over the orb, which shows through, blurred
    fill: 'rgba(11, 11, 11, 0.72)',
    border: '#1f1f1f',
    bracket: '#ffffff',
    rule: '#2a2a2a',
    title: '#ffffff',
    text: '#d4d4d4',
    muted: '#8a8a8a',
  },
  brain: { ...orbPaletteOf('dark').brain, muted: hexToRgb('#5a5a5a') },
}

/** The colour of one mode, as a fresh copy (the orb eases its colour in place). */
export const voiceOrbColorOf = (mode: keyof OrbColors): [number, number, number] => [
  ...VOICE_ORB_PALETTE.orb[mode],
]
