import { describe, expect, test } from 'bun:test'
import type { BudgetPerson, BudgetStatus } from '@keith/contracts'
import { budgetViewOf, personBarsOf, personTone } from './budget-view.ts'

const person = (over: Partial<BudgetPerson>): BudgetPerson => ({
  personId: 'p1',
  username: 'ana',
  name: 'Ana',
  limitUsd: 5,
  spentUsd: 1,
  reservedUsd: 0,
  remainingUsd: 4,
  ...over,
})

const status = (over: Partial<BudgetStatus>): BudgetStatus => ({
  scope: 'owner',
  limitUsd: 20,
  spentUsd: 4,
  reservedUsd: 0,
  remainingUsd: 16,
  periodStart: Date.UTC(2026, 10, 1),
  periodEnd: Date.UTC(2026, 11, 1),
  unpriced: [],
  ...over,
})

describe('person bars', () => {
  test('scaled to the largest of anyone, biggest spender first, with a cap tick', () => {
    const bars = personBarsOf([
      person({ personId: 'a', name: 'Ana', username: 'ana', spentUsd: 2, limitUsd: 4 }),
      person({
        personId: 'b',
        name: 'Bo',
        username: 'bo',
        spentUsd: 8,
        limitUsd: null,
        remainingUsd: null,
      }),
    ])
    expect(bars.map((b) => b.id)).toEqual(['b', 'a'])
    expect(bars[0]).toMatchObject({ spentPercent: 100, capPercent: undefined, cap: 'no cap' })
    expect(bars[1]).toMatchObject({ spentPercent: 25, capPercent: 50 })
  })
  test('the label says spend, cap and share', () => {
    const [bar] = personBarsOf([person({ spentUsd: 3.2, limitUsd: 5 })])
    expect(bar?.label).toBe('ana: $3.20 spent, cap $5.00 (64%)')
  })
  test('tone follows the person cap: warning at 80 %, danger at 100 %', () => {
    expect(personTone({ limitUsd: 5, spentUsd: 3.9 })).toBeUndefined()
    expect(personTone({ limitUsd: 5, spentUsd: 4 })).toBe('warning')
    expect(personTone({ limitUsd: 5, spentUsd: 5 })).toBe('danger')
    expect(personTone({ limitUsd: null, spentUsd: 99 })).toBeUndefined()
  })
  test('no one yet gives no bars', () => {
    expect(personBarsOf([])).toEqual([])
  })
})

describe('the view', () => {
  test('the owner sees the global rows and the people', () => {
    const view = budgetViewOf(status({ people: [person({})] }))
    expect(view.own).toBe(false)
    expect(view.heading).toBe('this month')
    expect(view.rows[0]).toEqual(['Monthly limit', '$20.00'])
    expect(view.people).toHaveLength(1)
    expect(view.warning).toBeUndefined()
  })
  test('a member sees their own cap and no people', () => {
    const view = budgetViewOf(
      status({ scope: 'person:p1', limitUsd: 5, spentUsd: 1, remainingUsd: 4 }),
    )
    expect(view.own).toBe(true)
    expect(view.heading).toBe('your spend this month')
    expect(view.rows[0]).toEqual(['Your cap', '$5.00 (set by the owner)'])
    expect(view.footer).toBe('The cap is set by the owner.')
  })
  test('the 80 % warning and the reached line', () => {
    expect(budgetViewOf(status({ spentUsd: 16 })).warning).toBe('! over 80% of the limit')
    expect(budgetViewOf(status({ spentUsd: 20, remainingUsd: 0 })).warning).toBe('! limit reached')
  })
  test('reserved spend and unpriced models are reported', () => {
    const view = budgetViewOf(status({ reservedUsd: 1.5, unpriced: ['x/y'] }))
    expect(view.reserved).toBe('$1.50 reserved by running turns')
    expect(view.unpriced).toEqual(['x/y'])
  })
})
