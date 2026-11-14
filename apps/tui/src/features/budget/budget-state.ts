import type { BudgetPerson, BudgetStatus } from '@keith/contracts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `$3.21` (always cents). */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

/** `$20` or `$20.5`: a limit without the zeros nobody typed. */
function limitText(limit: number): string {
  return `$${Number(limit.toFixed(2))}`
}

/** `$3.21 / $20 this month`, or `$3.21 this month` without a limit (the Home menu's Budget box). */
export function headerSpend(budget: BudgetStatus): string {
  const spent = usd(budget.spentUsd)
  if (budget.limitUsd === null) return `${spent} this month`
  return `${spent} / ${limitText(budget.limitUsd)} this month`
}

/** `warning` from 80 % of the limit, `danger` from 100 %; nothing without a limit. */
export function spendTone(budget: BudgetStatus): 'warning' | 'danger' | undefined {
  if (budget.limitUsd === null || budget.limitUsd <= 0) return undefined
  const used = budget.spentUsd / budget.limitUsd
  return used >= 1 ? 'danger' : used >= 0.8 ? 'warning' : undefined
}

const day = (at: number): string => {
  const d = new Date(at)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** `1 Oct 2026 – 31 Oct 2026`: the month in UTC (the period ends just before `periodEnd`). */
export function periodText(budget: BudgetStatus): string {
  return `${day(budget.periodStart)} – ${day(budget.periodEnd - 1)}`
}

/** The rows of `/budget`: label and value. */
export function budgetRows(budget: BudgetStatus): Array<[string, string]> {
  return [
    ['Monthly limit', budget.limitUsd === null ? 'no limit' : usd(budget.limitUsd)],
    ['Spent', usd(budget.spentUsd)],
    ...(budget.reservedUsd > 0
      ? ([['Reserved', `${usd(budget.reservedUsd)} (running turn)`]] as Array<[string, string]>)
      : []),
    ['Remaining', budget.remainingUsd === null ? '-' : usd(budget.remainingUsd)],
    ['Period', periodText(budget)],
  ]
}

/** The lines of `/budget` as plain text. */
export function budgetLines(budget: BudgetStatus): string[] {
  return budgetRows(budget).map(([k, v]) => `${k.padEnd(14)}${v}`)
}

/** A person's own view (a member): the core sent no per-person table. */
export const isOwnView = (budget: BudgetStatus): boolean => budget.people === undefined

/** The rows of a member's `/budget`: their own cap, spend and what is left. */
export function ownBudgetRows(budget: BudgetStatus): Array<[string, string]> {
  return [
    [
      'Your cap',
      budget.limitUsd === null ? 'no cap' : `${usd(budget.limitUsd)} (set by the owner)`,
    ],
    ['Spent', usd(budget.spentUsd)],
    ...(budget.reservedUsd > 0
      ? ([['Reserved', `${usd(budget.reservedUsd)} (running turn)`]] as Array<[string, string]>)
      : []),
    ['Remaining', budget.remainingUsd === null ? '-' : usd(budget.remainingUsd)],
    ['Period', periodText(budget)],
  ]
}

/** One person's cap, spend and remaining as table cells. */
export function personCells(person: BudgetPerson): {
  who: string
  cap: string
  spent: string
  left: string
} {
  return {
    who: person.username ?? person.name,
    cap: person.limitUsd === null ? 'no cap' : usd(person.limitUsd),
    spent: usd(person.spentUsd),
    left: person.remainingUsd === null ? '-' : usd(person.remainingUsd),
  }
}
