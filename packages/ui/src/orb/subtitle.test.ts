import { describe, expect, test } from 'bun:test'
import { cells } from '../text-width.ts'
import { centerRow, subtitleRows, wordWrap } from './subtitle.ts'

describe('wordWrap', () => {
  test('wraps at spaces', () => {
    expect(wordWrap('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  test('hard-breaks a word longer than a row', () => {
    const rows = wordWrap('see https://example.com/a/very/long/path ok', 10)
    for (const r of rows) expect(cells(r)).toBeLessThanOrEqual(10)
    expect(rows.join('').replaceAll(' ', '')).toBe('seehttps://example.com/a/very/long/pathok')
    expect(rows[0]).toBe('see')
  })

  test('never exceeds the width, for wide glyphs too, at widths 1..30', () => {
    for (let w = 1; w <= 30; w++) {
      for (const r of wordWrap('日本語のとても長い文章 and some words, plus x'.repeat(2), w)) {
        // a single glyph wider than the row (width 1) is the only allowed overflow
        expect(cells(r), `width ${w}`).toBeLessThanOrEqual(Math.max(w, 2))
      }
    }
  })

  test('empty text gives no rows', () => {
    expect(wordWrap('   \n ', 10)).toEqual([])
  })
})

describe('subtitleRows', () => {
  test('keeps the newest rows', () => {
    expect(subtitleRows('a b c d e f', 3)).toEqual(['c d', 'e f'])
    expect(subtitleRows('a b c d e f', 3, 3)).toEqual(['a b', 'c d', 'e f'])
  })

  test('centerRow pads the left', () => {
    expect(centerRow('ab', 10)).toBe('    ab')
  })
})
