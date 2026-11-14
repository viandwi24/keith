import { describe, expect, test } from 'bun:test'
import { modelRef, parsePrice } from './use-providers.ts'

describe('parsePrice (P24.4.4)', () => {
  test('a plain decimal number of USD per million tokens', () => {
    expect(parsePrice('1.5')).toBe(1.5)
    expect(parsePrice(' 6 ')).toBe(6)
    expect(parsePrice('0')).toBe(0)
  })

  test('anything else, or above 10000, is refused', () => {
    for (const text of ['', '-1', '1e3', '0x10', 'NaN', 'free', '10001']) {
      expect(() => parsePrice(text)).toThrow()
    }
  })

  test('a bare model id gets its connection in front', () => {
    expect(modelRef('openrouter', 'x/y')).toBe('openrouter:x/y')
    expect(modelRef('openrouter', 'openrouter:x/y')).toBe('openrouter:x/y')
  })
})
