import { describe, expect, test } from 'bun:test'
import { BudgetSetSchema, BudgetStatusSchema, parseUsdLimit } from './budget.ts'

const status = {
  scope: 'owner',
  limitUsd: 5,
  spentUsd: 1.5,
  reservedUsd: 0.5,
  remainingUsd: 3,
  periodStart: Date.UTC(2026, 9, 1),
  periodEnd: Date.UTC(2026, 10, 1),
  unpriced: [],
}

describe('budget', () => {
  test('status accepts a limit or none', () => {
    expect(BudgetStatusSchema.safeParse(status).success).toBe(true)
    expect(
      BudgetStatusSchema.safeParse({ ...status, limitUsd: null, remainingUsd: null }).success,
    ).toBe(true)
    expect(BudgetStatusSchema.safeParse({ ...status, spentUsd: -1 }).success).toBe(false)
    expect(BudgetStatusSchema.safeParse({ ...status, periodEnd: undefined }).success).toBe(false)
    expect(BudgetStatusSchema.safeParse({ ...status, unpriced: undefined }).success).toBe(false)
  })

  test('set takes 0..10000 or null', () => {
    for (const limitUsd of [0, 5, 10_000, null]) {
      expect(BudgetSetSchema.safeParse({ limitUsd }).success).toBe(true)
    }
    for (const limitUsd of [-0.01, 10_000.01, Number.NaN, '5']) {
      expect(BudgetSetSchema.safeParse({ limitUsd }).success).toBe(false)
    }
    expect(BudgetSetSchema.safeParse({}).success).toBe(false)
  })
})

describe('parseUsdLimit (P24.4.6, FD10-04)', () => {
  test('none removes the limit; a plain decimal of USD up to 10000 with two places is the amount', () => {
    expect(parseUsdLimit('none')).toBeNull()
    expect(parseUsdLimit(' NONE ')).toBeNull()
    expect(parseUsdLimit('0')).toBe(0)
    expect(parseUsdLimit(' 12.5 ')).toBe(12.5)
    expect(parseUsdLimit('10000')).toBe(10000)
    expect(parseUsdLimit('0.01')).toBe(0.01)
  })

  test('empty, blank, hex, exponent, NaN, negative, unlimited and above 10000 are refused with a sentence that names none', () => {
    for (const bad of [
      '',
      '   ',
      '0x10',
      '1e3',
      'NaN',
      'Infinity',
      '-1',
      'unlimited',
      '10000.01',
      '10001',
      '1.234',
      '.5',
    ]) {
      const result = parseUsdLimit(bad)
      expect(typeof result).toBe('string')
      expect(result as string).toContain('none')
    }
  })
})
