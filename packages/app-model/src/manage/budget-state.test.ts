import { describe, expect, test } from 'bun:test'
import { budgetLines, parseUsd } from './budget-state.ts'

describe('parseUsd', () => {
  test('a number of USD, or none for no limit', () => {
    expect(parseUsd('12.5')).toBe(12.5)
    expect(parseUsd(' 0 ')).toBe(0)
    expect(parseUsd('none')).toBeNull()
    expect(parseUsd('NONE')).toBeNull()
  })

  test('anything else is a sentence for the form', () => {
    for (const bad of ['', 'abc', '-1', '10001', 'Infinity', '0x10', '1e3', 'NaN', 'unlimited'])
      expect(() => parseUsd(bad)).toThrow()
  })
})

describe('budgetLines', () => {
  const base = {
    scope: 'owner',
    limitUsd: 20,
    spentUsd: 1.5,
    reservedUsd: 0,
    remainingUsd: 18.5,
    periodStart: 0,
    periodEnd: 1,
    unpriced: [],
  }
  test('spent, limit and what is left; a member is told it is their own spend', () => {
    expect(budgetLines(base)).toEqual(['this month: $1.50 spent, limit $20.00, $18.50 left'])
    expect(budgetLines({ ...base, scope: 'person:ana' })[0]).toContain('(your spend)')
    expect(budgetLines({ ...base, limitUsd: null, remainingUsd: null })[0]).toContain('no limit')
  })
})
