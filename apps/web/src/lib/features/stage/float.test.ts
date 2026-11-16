import { describe, expect, test } from 'bun:test'
import { backdrop, FLOAT_MS, float, floatCss } from './float.ts'

describe('the workspace floating over the orb', () => {
  test('rises and grows into place while it fades in', () => {
    expect(floatCss(0)).toBe('opacity: 0.0000; transform: translateY(24px) scale(0.9400)')
    expect(floatCss(1)).toBe('opacity: 1.0000; transform: translateY(0px) scale(1.0000)')
  })

  test('instant under reduced motion', () => {
    const node = {} as Element
    expect(float(node, { reduced: false }).duration).toBe(FLOAT_MS)
    expect(float(node, { reduced: true }).duration).toBe(0)
    expect(backdrop(node, { reduced: true }).duration).toBe(0)
    expect(backdrop(node, { reduced: false }).css(0.5)).toBe('opacity: 0.5000')
  })
})
