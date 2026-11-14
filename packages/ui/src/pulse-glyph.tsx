import { Text } from 'ink'
import { paint } from './orb/color.ts'
import { pulseGlyph, STILL_GLYPH } from './orb/glyph.ts'
import type { OrbMode } from './orb/orb.ts'
import { type Tone, Txt } from './text.tsx'
import { useSpinnerEnabled } from './theme-context.tsx'
import { useFrameClock } from './use-frame-clock.ts'
import { useOrbPalette } from './use-orb-palette.ts'

export interface PulseGlyphProps {
  /** The colour of an orb mode (default `thinking`): the chat's title and prompt follow the orb. */
  mode?: OrbMode
  /** A theme tone instead of an orb mode: `info` while connecting, `accent` while a message streams. */
  tone?: Tone
  /** `false` stops the timer and freezes the mark. */
  running?: boolean
}

/**
 * The one activity indicator (tui-design 3): `· ✢ ✳ ✶ ✻ ✽` pulsing, coloured by state. The glyph
 * comes from the wall clock, so every PulseGlyph on a screen shows the same one. Static `✳` where
 * animation is off (none depth, tests).
 */
export function PulseGlyph({ mode = 'thinking', tone, running = true }: PulseGlyphProps) {
  const palette = useOrbPalette()
  const animated = useSpinnerEnabled()
  useFrameClock({ fps: 8, running: running && animated })
  const glyph = animated ? pulseGlyph(performance.now() / 1000) : STILL_GLYPH
  if (tone !== undefined) return <Txt tone={tone}>{glyph}</Txt>
  if (palette.env.depth === 'none') return <Text>{glyph}</Text>
  return <Text>{paint(glyph, palette.orb[mode], palette.env.depth)}</Text>
}
