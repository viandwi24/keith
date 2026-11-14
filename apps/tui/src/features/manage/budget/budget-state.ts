import { type BudgetPerson, type BudgetStatus, parseUsdLimit } from '@keith/contracts'

export const usd = (n: number): string => `$${n.toFixed(2)}`

/** `none` removes a limit, else a number of USD (the contract's one parser). Throws a sentence the form shows. */
export function parseUsd(text: string): number | null {
  const parsed = parseUsdLimit(text)
  if (typeof parsed === 'string') throw new Error(`enter ${parsed}`)
  return parsed
}

/** The lines above the list: the month's limit and spend. */
export function budgetLines(s: BudgetStatus): string[] {
  const limit = s.limitUsd === null ? 'no limit' : `limit ${usd(s.limitUsd)}`
  const left = s.remainingUsd === null ? '' : `, ${usd(s.remainingUsd)} left`
  const own = s.scope.startsWith('person:') ? ' (your spend)' : ''
  return [`this month${own}: ${usd(s.spentUsd)} spent, ${limit}${left}`]
}

export function personCells(p: BudgetPerson): string[] {
  return [
    p.username ?? p.name,
    usd(p.spentUsd),
    p.limitUsd === null ? 'no cap' : `cap ${usd(p.limitUsd)}`,
    p.remainingUsd === null ? '' : `${usd(p.remainingUsd)} left`,
  ]
}
