/** The pulsing mark of the chat: it grows to `✽` and shrinks back, 8 steps a second. */
export const PULSE_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'] as const
export const PULSE_PER_SECOND = 8
/** The mark where nothing animates (no colour). */
export const STILL_GLYPH = '✳'

/** The glyph at `seconds` on any clock; two components asking at the same moment show the same one. */
export function pulseGlyph(seconds: number): string {
  const i = Math.floor(seconds * PULSE_PER_SECOND) % PULSE_GLYPHS.length
  return PULSE_GLYPHS[i < 0 ? i + PULSE_GLYPHS.length : i] ?? STILL_GLYPH
}
