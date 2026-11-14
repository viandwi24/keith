import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { summarizeRatioFor, windowOfModel } from './summarize-at.ts'

// audit F14: the summarize trigger is the smaller of the ratio and 200,000 tokens of the model's window.

describe('summarizeRatioFor', () => {
  test('a small window keeps the plain ratio 0.65', () => {
    expect(summarizeRatioFor(128_000)).toBe(0.65)
    expect(summarizeRatioFor(200_000)).toBe(0.65)
  })

  test('a 1M window summarizes at 200k tokens: the ratio is 200000 / window', () => {
    expect(summarizeRatioFor(1_048_576)).toBeCloseTo(200_000 / 1_048_576, 12)
    expect(summarizeRatioFor(1_000_000)).toBeCloseTo(0.2, 12)
    // 200k of that window is the trigger in tokens
    expect(Math.round(summarizeRatioFor(1_000_000) * 1_000_000)).toBe(200_000)
  })

  test('the result never exceeds 0.65 and is always inside eharness range (0, 1)', () => {
    for (const window of [1, 10_000, 250_000, 400_000, 2_000_000]) {
      const ratio = summarizeRatioFor(window)
      expect(ratio).toBeGreaterThan(0)
      expect(ratio).toBeLessThan(1)
      expect(ratio).toBeLessThanOrEqual(0.65)
    }
  })

  test('an unknown or non-positive window keeps the plain ratio', () => {
    expect(summarizeRatioFor(undefined)).toBe(0.65)
    expect(summarizeRatioFor(0)).toBe(0.65)
    expect(summarizeRatioFor(-5)).toBe(0.65)
    expect(summarizeRatioFor(Number.NaN)).toBe(0.65)
  })
})

describe('windowOfModel', () => {
  const model = { modelId: 'deepseek-v4-flash' } as unknown as LanguageModel

  test('reads the window from a record catalog by model id, and from a function catalog', () => {
    expect(windowOfModel({ 'deepseek-v4-flash': { contextWindow: 1_048_576 } }, model)).toBe(
      1_048_576,
    )
    expect(windowOfModel(() => ({ contextWindow: 64_000 }), model)).toBe(64_000)
  })

  test('an unknown model has no window', () => {
    expect(windowOfModel({}, model)).toBeUndefined()
    expect(windowOfModel(() => undefined, model)).toBeUndefined()
  })
})
