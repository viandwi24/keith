// `@keith/ui/orb`: the orb model for a browser. Pure: no Ink, no React, no Bun API, no `node:` import (orb-subpath.test.ts walks
// the import graph). The terminal draws the particles as braille; the web draws them on a canvas from the same model.
export {
  type BrainColors,
  BrainTrace,
  LIST_ORDER,
  LIST_ROWS,
  MAX_SAMPLES,
  REGIONS,
  type Region,
  regionLabel,
  type Sample,
} from './brain-trace.ts'
export { fade, hexToRgb, type Rgb } from './color.ts'
export {
  MODE_DEFS,
  MODES,
  ORB_RADIUS,
  Orb,
  type OrbColors,
  type OrbMode,
  type Particle,
  POINTS,
  RINGS,
} from './orb.ts'
export { type OrbPaletteColors, orbPaletteOf } from './palette.ts'
export { advanceShown, CATCH_UP, DEFAULT_CPS, retargetShown } from './typewriter.ts'
export {
  type HudPanelColors,
  VOICE_ORB_PALETTE,
  type VoiceOrbPalette,
  voiceOrbColorOf,
} from './voice-palette.ts'
export { pointCells, pureCells } from './width.ts'
export { subtitleRowsWith, type WidthOf, wordWrapWith } from './wrap.ts'
