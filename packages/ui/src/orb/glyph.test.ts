import { describe, expect, test } from 'bun:test'
import { PULSE_GLYPHS, pulseGlyph } from './glyph.ts'

describe('pulseGlyph', () => {
  test('starts small, peaks, and comes back', () => {
    expect(pulseGlyph(0)).toBe('·')
    expect(pulseGlyph(5 / 8)).toBe('✽')
    expect(pulseGlyph(9 / 8)).toBe('✢')
  })

  test('repeats every 10 steps', () => {
    expect(pulseGlyph(10 / 8)).toBe(pulseGlyph(0))
    expect(PULSE_GLYPHS).toHaveLength(10)
  })

  test('never returns undefined for a negative time', () => {
    expect(pulseGlyph(-0.5)).not.toBe('')
  })
})
