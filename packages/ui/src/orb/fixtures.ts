import type { BrainColors } from './brain-trace.ts'
import type { ColorEnv, Rgb } from './color.ts'
import type { FrameColors } from './frame-text.ts'
import type { OrbColors } from './orb.ts'

// Test-only colours (kept out of the pure modules, which take colours as arguments).
const c = (r: number, g: number, b: number): Rgb => [r, g, b]

export const ORB_COLORS: OrbColors = {
  idle: c(212, 212, 212),
  listening: c(74, 222, 128),
  thinking: c(165, 180, 252),
  speaking: c(255, 255, 255),
  alert: c(248, 113, 113),
}

export const BRAIN_COLORS: BrainColors = {
  regions: {
    thalamus: c(125, 211, 252),
    wernicke: c(196, 181, 253),
    broca: c(251, 191, 36),
    cortex: c(230, 230, 230),
    motor: c(74, 222, 128),
    amygdala: c(248, 113, 113),
    ras: c(148, 163, 184),
    hippocampus: c(244, 114, 182),
    parietal: c(255, 163, 102),
    hypothalamus: c(250, 204, 21),
    'corpus-callosum': c(94, 234, 212),
    prefrontal: c(163, 230, 53),
  },
  muted: c(140, 146, 160),
}

export const FRAME_COLORS: FrameColors = {
  border: c(110, 118, 135),
  text: c(225, 228, 235),
  accent: c(138, 180, 248),
}

export const DARK: ColorEnv = { depth: 'truecolor', background: c(22, 24, 29) }
export const LIGHT: ColorEnv = { depth: 'truecolor', background: c(250, 250, 250) }
export const PLAIN: ColorEnv = { depth: 'none', background: c(22, 24, 29) }
