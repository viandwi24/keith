import { describe, expect, test } from 'bun:test'
import type { BudgetStatus } from '@keith/contracts'
import { budgetLines, headerSpend, periodText, spendTone } from './budget-state.ts'

const status: BudgetStatus = {
  scope: 'owner',
  limitUsd: 20,
  spentUsd: 3.214,
  reservedUsd: 0,
  remainingUsd: 16.786,
  periodStart: Date.UTC(2026, 9, 1),
  periodEnd: Date.UTC(2026, 10, 1),
  unpriced: [],
}

describe('budget state', () => {
  test('header: spent over limit, or spent alone without a limit', () => {
    expect(headerSpend(status)).toBe('$3.21 / $20 this month')
    expect(headerSpend({ ...status, limitUsd: 7.5 })).toBe('$3.21 / $7.5 this month')
    expect(headerSpend({ ...status, limitUsd: null, remainingUsd: null })).toBe('$3.21 this month')
  })

  test('the spend turns warning at 80 % of the limit and danger at 100 %', () => {
    expect(spendTone(status)).toBeUndefined()
    expect(spendTone({ ...status, spentUsd: 16 })).toBe('warning')
    expect(spendTone({ ...status, spentUsd: 19.99 })).toBe('warning')
    expect(spendTone({ ...status, spentUsd: 20 })).toBe('danger')
    expect(spendTone({ ...status, limitUsd: null })).toBeUndefined()
  })

  test('the period ends on the last day of the month', () => {
    expect(periodText(status)).toBe('1 Oct 2026 – 31 Oct 2026')
  })

  test('lines show limit, spent, remaining, period and a reservation only when there is one', () => {
    expect(budgetLines(status).join('\n')).toContain('$16.79')
    expect(budgetLines(status).some((l) => l.startsWith('Reserved'))).toBe(false)
    expect(budgetLines({ ...status, reservedUsd: 0.5 }).some((l) => l.startsWith('Reserved'))).toBe(
      true,
    )
  })
})
