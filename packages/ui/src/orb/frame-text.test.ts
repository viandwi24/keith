import { describe, expect, test } from 'bun:test'
import { ESC, paint, stripAnsi, visibleWidth } from './color.ts'
import { FRAME_COLORS } from './fixtures.ts'
import { frame, frameStyle } from './frame-text.ts'

const style = frameStyle(FRAME_COLORS, 'truecolor')
const plain = frameStyle(FRAME_COLORS, 'none')

describe('frame', () => {
  test('rounded corners, tag in the border, body in the sides', () => {
    const rows = frame({ width: 24, style: plain, top: [{ text: 'idle' }], body: ['hello'] })
    expect(rows[0]?.startsWith('╭─ idle ')).toBe(true)
    expect(rows[0]?.endsWith('─╮')).toBe(true)
    expect(rows[1]).toBe(`│hello${' '.repeat(17)}│`)
    expect(rows[2]?.startsWith('╰')).toBe(true)
    expect(rows[2]?.endsWith('╯')).toBe(true)
  })

  test('hotkey letter takes the accent colour, the rest the text colour', () => {
    const [top = ''] = frame({ width: 30, style, top: [{ text: 'brain', hot: true }], body: [] })
    expect(top).toContain(`${style.accent}b`)
    expect(top).toContain(`${style.text}rain`)
    expect(stripAnsi(top)).toContain('╭─ brain ─')
  })

  test('bottom and top-right tags, centre label', () => {
    const rows = frame({
      width: 40,
      style: plain,
      top: [{ text: 'a' }],
      topRight: [{ text: 'live' }],
      center: 'mid',
      bottom: [{ text: 'q', hot: true }, { text: 'w' }],
      body: ['x'],
    })
    expect(rows[0]).toContain(' mid ')
    expect(rows[0]?.endsWith(' live ─╮')).toBe(true)
    expect(rows[2]?.startsWith('╰─ q ─ w ')).toBe(true)
  })

  test('none depth has no escape codes', () => {
    const rows = frame({
      width: 30,
      style: plain,
      top: [{ text: 'x', hot: true }],
      body: ['a', 'b'],
    })
    expect(rows.join('')).not.toContain(ESC)
  })

  test('every row is exactly the width at widths 10..140, long tags and bodies included', () => {
    for (let width = 10; width <= 140; width++) {
      const rows = frame({
        width,
        style,
        top: [{ text: 'a very long label indeed', hot: true }, { text: 'second tag' }],
        topRight: [{ text: '● live' }],
        center: 'centre text',
        bottom: [{ text: 'enter', hot: true }, { text: 'a bottom tag that is long' }],
        body: [paint('x'.repeat(300), [1, 2, 3], 'truecolor'), '', 'short', '日本語'.repeat(20)],
      })
      for (const row of rows) expect(visibleWidth(row), `width ${width}`).toBe(width)
    }
  })

  test('a width below 2 still gives rows of 2 cells', () => {
    for (const row of frame({ width: 0, style: plain, body: ['x'] })) expect(row.length).toBe(2)
  })
})
