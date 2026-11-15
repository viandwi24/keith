import {
  budgetRows,
  isOwnView,
  ownBudgetRows,
  periodText,
  personCells,
  spendTone,
  usd,
} from '@keith/app-model'
import type { BudgetPerson, BudgetStatus } from '@keith/contracts'
// the pure view module, not the feature index: the index pulls in the runes store, which a test cannot load
import { type BudgetBar, budgetBar } from '../live/view.ts'

// View models of the Budget screen: the owner's global view with a row per person, a member's own view, the 80 % warning.

export type Tone = 'warning' | 'danger' | undefined

export interface PersonBar {
  id: string
  who: string
  spent: string
  cap: string
  left: string
  /** Spend as a share of the chart's scale, 0 to 100. */
  spentPercent: number
  /** Where the cap sits on the scale (0 to 100), or undefined without a cap. */
  capPercent: number | undefined
  /** From 80 % of the person's cap. */
  tone: Tone
  /** `Ana: $3.20 of $5.00 (64%)`, the label a screen reader gets. */
  label: string
}

/** The spend of one person against their own cap: warning from 80 %, danger from 100 %; nothing without a cap. */
export function personTone(person: Pick<BudgetPerson, 'limitUsd' | 'spentUsd'>): Tone {
  if (person.limitUsd === null || person.limitUsd <= 0) return undefined
  const used = person.spentUsd / person.limitUsd
  return used >= 1 ? 'danger' : used >= 0.8 ? 'warning' : undefined
}

/**
 * One bar per person, scaled to the largest of anyone's spend or cap so the bars compare with each other; a person with a cap
 * also gets a tick where the cap sits. The biggest spenders come first.
 */
export function personBarsOf(people: readonly BudgetPerson[]): PersonBar[] {
  const scale = Math.max(0.01, ...people.flatMap((p) => [p.spentUsd, p.limitUsd ?? 0]))
  const share = (n: number): number => Math.min(100, Math.round((n / scale) * 1000) / 10)
  return [...people]
    .sort((a, b) => b.spentUsd - a.spentUsd || a.name.localeCompare(b.name))
    .map((p) => {
      const cells = personCells(p)
      const used =
        p.limitUsd === null || p.limitUsd <= 0
          ? ''
          : ` (${Math.round((p.spentUsd / p.limitUsd) * 100)}%)`
      return {
        id: p.personId,
        who: cells.who,
        spent: cells.spent,
        cap: cells.cap,
        left: cells.left,
        spentPercent: share(p.spentUsd),
        capPercent: p.limitUsd === null ? undefined : share(p.limitUsd),
        tone: personTone(p),
        label: `${cells.who}: ${cells.spent} spent, cap ${p.limitUsd === null ? 'none' : cells.cap}${used}`,
      }
    })
}

export interface BudgetView {
  /** A member's own view: no per-person table. */
  own: boolean
  /** `your spend this month` or `this month`. */
  heading: string
  rows: Array<[string, string]>
  bar: BudgetBar | undefined
  /** The 80 % line (`over 80% of the limit`) or the reached line; undefined below. */
  warning: string | undefined
  tone: Tone
  people: PersonBar[]
  period: string
  /** `$1.20 reserved by running turns`, or undefined. */
  reserved: string | undefined
  /** Models that spent without a catalog price: their cost is missing from the numbers. */
  unpriced: string[]
  footer: string
}

export function budgetViewOf(budget: BudgetStatus): BudgetView {
  const own = isOwnView(budget) && budget.scope.startsWith('person:')
  const bar = budgetBar(budget)
  return {
    own,
    heading: own ? 'your spend this month' : 'this month',
    rows: own ? ownBudgetRows(budget) : budgetRows(budget),
    bar,
    warning: bar?.warning === undefined ? undefined : `! ${bar.warning}`,
    tone: spendTone(budget),
    people: budget.people === undefined ? [] : personBarsOf(budget.people),
    period: periodText(budget),
    reserved:
      budget.reservedUsd > 0 ? `${usd(budget.reservedUsd)} reserved by running turns` : undefined,
    unpriced: budget.unpriced,
    footer: own
      ? 'The cap is set by the owner.'
      : 'Limits are set on the core machine: keith-core budget set <usd|none>',
  }
}
