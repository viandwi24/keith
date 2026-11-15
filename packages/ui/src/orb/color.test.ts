import { describe, expect, test } from 'bun:test'
import { clipAnsi, visibleWidth } from './ansi-width.ts'
import { ESC, fade, hexToRgb, paint, quantize16, quantize256, sgr, stripAnsi } from './color.ts'

describe('colour depth', () => {
  test('truecolor writes the exact rgb', () => {
    expect(sgr([1, 2, 3], 'truecolor')).toBe(`${ESC}[38;2;1;2;3m`)
  })

  test('256 quantises to the cube, the grey ramp or the corners', () => {
    expect(sgr([255, 0, 0], '256')).toBe(`${ESC}[38;5;196m`)
    expect(quantize256([255, 255, 255])).toBe(231)
    expect(quantize256([0, 0, 0])).toBe(16)
    const grey = quantize256([128, 128, 128])
    expect(grey).toBeGreaterThanOrEqual(232)
    expect(grey).toBeLessThanOrEqual(255)
    expect(quantize256([30, 200, 60])).toBeGreaterThanOrEqual(16)
  })

  test('16 maps to the 30-37 and 90-97 codes', () => {
    expect(quantize16([255, 0, 0])).toBe(91)
    expect(quantize16([0, 255, 0])).toBe(92)
    expect(quantize16([0, 0, 255])).toBe(94)
    expect(quantize16([255, 255, 255])).toBe(97)
    expect(quantize16([120, 0, 0])).toBe(31)
    for (const c of [quantize16([10, 10, 10]), quantize16([212, 212, 212])]) {
      expect((c >= 30 && c <= 37) || (c >= 90 && c <= 97)).toBe(true)
    }
    expect(sgr([255, 0, 0], '16')).toBe(`${ESC}[91m`)
  })

  test('none gives no escape: paint is the text itself', () => {
    expect(sgr([255, 0, 0], 'none')).toBe('')
    expect(paint('hi', [255, 0, 0], 'none')).toBe('hi')
    expect(paint('hi', [255, 0, 0], 'truecolor')).toContain(ESC)
  })

  test('hexToRgb', () => {
    expect(hexToRgb('#8ab4f8')).toEqual([138, 180, 248])
  })
})

describe('fade', () => {
  test('toward black on a dark background, toward white on a light one', () => {
    expect(fade([200, 100, 50], 0, [0, 0, 0])).toEqual([0, 0, 0])
    expect(fade([200, 100, 50], 0, [250, 250, 250])).toEqual([250, 250, 250])
    expect(fade([200, 100, 50], 1, [250, 250, 250])).toEqual([200, 100, 50])
  })

  test('a faded dark colour gets lighter on a light background, darker on a dark one', () => {
    const c: [number, number, number] = [40, 40, 40]
    const onLight = fade(c, 0.4, [250, 250, 250])
    const onDark = fade(c, 0.4, [20, 20, 20])
    expect(onLight[0]).toBeGreaterThan(c[0])
    expect(onDark[0]).toBeLessThan(c[0])
  })
})

describe('ansi strings', () => {
  test('visibleWidth ignores escapes; clipAnsi cuts by cells and closes the colour', () => {
    const s = paint('abcdef', [1, 2, 3], 'truecolor')
    expect(visibleWidth(s)).toBe(6)
    const cut = clipAnsi(s, 3)
    expect(stripAnsi(cut)).toBe('abc')
    expect(cut.endsWith(`${ESC}[0m`)).toBe(true)
    expect(clipAnsi('abc', 0)).toBe('')
    expect(clipAnsi('abc', 5)).toBe('abc')
  })
})
