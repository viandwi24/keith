import { describe, expect, test } from 'bun:test'
import { cells } from './text-width.ts'
import { ALERT_MAX_LINES, alertLinesOf, wrapLines } from './wrap-lines.ts'

describe('wrapLines', () => {
  test('wraps on word boundaries to the width', () => {
    expect(wrapLines('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  test('a text that fits gives its rows and no ellipsis', () => {
    expect(wrapLines('short text', 40, 4)).toEqual(['short text'])
    expect(wrapLines('a b c d', 1, 4)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('exactly four rows: no ellipsis', () => {
    expect(wrapLines('aa bb cc dd', 2, 4)).toEqual(['aa', 'bb', 'cc', 'dd'])
  })

  test('a fifth row is cut: the fourth ends with an ellipsis and fits the width', () => {
    const rows = wrapLines('aa bb cc dd ee', 3, 4)
    expect(rows).toHaveLength(4)
    expect(rows[3]).toBe('dd…')
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(3)
  })

  test('a very long unbroken token is hard-split, not dropped', () => {
    const path = '/Users/someone/Projects/keith/.data/test/data/core.sock'
    const rows = wrapLines(path, 10, 4)
    expect(rows.join('').startsWith('/Users/som')).toBe(true)
    expect(rows.every((r) => cells(r) <= 10)).toBe(true)
    expect(rows.length).toBeLessThanOrEqual(4)
  })

  test('a long unbroken token past four rows ends with an ellipsis', () => {
    const rows = wrapLines('x'.repeat(100), 10, 4)
    expect(rows).toHaveLength(4)
    expect(rows[3]?.endsWith('…')).toBe(true)
    expect(rows.every((r) => cells(r) <= 10)).toBe(true)
  })

  test('wide characters are measured in cells and never throw', () => {
    const rows = wrapLines('日本語のとても長い文章 and some words, plus x'.repeat(3), 7, 4)
    expect(rows.length).toBeLessThanOrEqual(4)
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(7)
  })

  test('an empty text gives no rows; a width below one is one cell', () => {
    expect(wrapLines('', 10, 4)).toEqual([])
    expect(wrapLines('ab', 0, 4)).toEqual(['a', 'b'])
    expect(() => wrapLines('ab', Number.NaN, 4)).not.toThrow()
  })

  test('the line cap of an alert: four rows, two on a terminal under twenty rows', () => {
    expect(ALERT_MAX_LINES).toBe(4)
    expect(alertLinesOf(19)).toBe(2)
    expect(alertLinesOf(20)).toBe(4)
    expect(alertLinesOf(undefined)).toBe(4)
  })
})
