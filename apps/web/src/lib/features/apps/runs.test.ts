import { describe, expect, test } from 'bun:test'
import { parseFrame } from '@keith/client/browser'
import { cssColorOf, rowsOf, styleOf } from './runs.ts'

describe('colours', () => {
  test('truecolor passes, names become tokens, ansi256 is computed', () => {
    expect(cssColorOf('#FF8800')).toBe('#ff8800')
    expect(cssColorOf('red')).toBe('var(--k-danger)')
    expect(cssColorOf('whiteBright')).toBe('var(--k-text)')
    expect(cssColorOf('ansi256(1)')).toBe('var(--k-danger)')
    expect(cssColorOf('ansi256(16)')).toBe('#000000')
    expect(cssColorOf('ansi256(196)')).toBe('#ff0000')
    expect(cssColorOf('ansi256(232)')).toBe('#080808')
    expect(cssColorOf('ansi256(255)')).toBe('#eeeeee')
  })
  test('anything else is dropped, never passed to CSS', () => {
    expect(cssColorOf('url(javascript:1)')).toBeUndefined()
    expect(cssColorOf('red; background:url(x)')).toBeUndefined()
    expect(cssColorOf('ansi256(300)')).toBeUndefined()
    expect(cssColorOf(undefined)).toBeUndefined()
  })
})

describe('styles', () => {
  test('flags become declarations', () => {
    expect(
      styleOf({ text: 'x', fg: 'green', bold: true, italic: true, underline: true, strike: true }),
    ).toBe(
      'color:var(--k-success);font-weight:700;font-style:italic;text-decoration:underline line-through',
    )
    expect(styleOf({ text: 'x', dim: true })).toBe('opacity:0.6')
    expect(styleOf({ text: 'x' })).toBe('')
  })
  test('inverse swaps the colours and falls back to the page colours', () => {
    expect(styleOf({ text: 'x', fg: 'red', bg: 'blue', inverse: true })).toBe(
      'color:var(--k-accent);background-color:var(--k-danger)',
    )
    expect(styleOf({ text: 'x', inverse: true })).toBe(
      'color:var(--k-bg);background-color:var(--k-text)',
    )
  })
})

describe('frame to grid', () => {
  test('rows of spans; neighbours of one style join; an empty line keeps one cell', () => {
    const frame = parseFrame('plain \u001b[31mred\u001b[0m\n\nend')
    const rows = rowsOf(frame)
    expect(rows.map((r) => r.spans.map((s) => s.text))).toEqual([['plain ', 'red'], [' '], ['end']])
    expect(rows[0]?.spans[1]?.style).toBe('color:var(--k-danger)')
    expect(rowsOf(undefined)).toEqual([])
    expect(
      rowsOf({
        lines: [[{ text: 'a' }, { text: 'b' }, { text: 'c', bold: true }]],
        truncated: false,
      })[0]?.spans,
    ).toEqual([
      { text: 'ab', style: '' },
      { text: 'c', style: 'font-weight:700' },
    ])
  })
  test('a hostile frame stays text', () => {
    const rows = rowsOf(parseFrame('<img src=x onerror=1>\u001b]0;title\u0007\u001b[2J'))
    expect(rows[0]?.spans.map((s) => s.text).join('')).toBe('<img src=x onerror=1>')
  })
})
