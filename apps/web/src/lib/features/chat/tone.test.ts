import { describe, expect, test } from 'bun:test'
import { clippedValue, jsonText, toneColor } from './tone.ts'

describe('tone and json helpers', () => {
  test('a tone is a token, never a literal', () => {
    expect(toneColor('danger')).toBe('var(--k-danger)')
    expect(toneColor('muted')).toBe('var(--k-text-muted)')
    expect(toneColor(undefined)).toBe('var(--k-text)')
  })

  test('jsonText keeps strings and pretty-prints the rest', () => {
    expect(jsonText('ls')).toBe('ls')
    expect(jsonText({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(jsonText(undefined)).toBe('undefined')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(typeof jsonText(loop)).toBe('string')
  })

  test('a clipped value carries the marker', () => {
    expect(clippedValue({ eharnessClipped: true, chars: 9000, preview: 'x' })).toBe(true)
    expect(clippedValue({ a: 1 })).toBe(false)
    expect(clippedValue('x')).toBe(false)
  })
})
