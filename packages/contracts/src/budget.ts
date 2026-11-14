import { z } from 'zod'

/** One person's spending and monthly cap in the current calendar month (UTC). */
export const BudgetPersonSchema = z.object({
  personId: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  /** The person's monthly cap in USD, or null when they have none (only the global limit applies). */
  limitUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  remainingUsd: z.number().nonnegative().nullable(),
})
export type BudgetPerson = z.infer<typeof BudgetPersonSchema>

/**
 * Spending in the current calendar month (UTC), as the caller sees it: a `budget.manage` holder
 * gets the global limit (scope `owner`, the global scope) plus `people`; anyone else gets their own
 * spend and cap (scope `person:<id>`), with `remainingUsd` also bounded by what is left globally.
 */
export const BudgetStatusSchema = z.object({
  /** Budget scope: `owner` (the global scope) or `person:<id>`. */
  scope: z.string(),
  /** Monthly limit in USD, or null when there is none. */
  limitUsd: z.number().nonnegative().nullable(),
  /** Committed and recorded spending this month. */
  spentUsd: z.number().nonnegative(),
  /** Reserved by turns in flight. */
  reservedUsd: z.number().nonnegative(),
  /** Limit minus spent and reserved (never below 0), or null without a limit. */
  remainingUsd: z.number().nonnegative().nullable(),
  /** First instant of the month (epoch ms, UTC). */
  periodStart: z.number().int(),
  /** First instant of the next month (epoch ms, UTC). */
  periodEnd: z.number().int(),
  /** Model refs that spent without a catalog price since boot (their cost is not counted). */
  unpriced: z.array(z.string()),
  /** `budget.manage` holders only: every person's spend and cap. */
  people: z.array(BudgetPersonSchema).optional(),
})
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>

/** Set the monthly limit (`null` removes it). */
export const BudgetSetSchema = z.object({
  limitUsd: z.number().min(0).max(10_000).nullable(),
})
export type BudgetSet = z.infer<typeof BudgetSetSchema>

/** Set one person's monthly cap (`usd: null` removes it). `person` is an id or a username. */
export const BudgetCapSetSchema = z.object({
  person: z.string().min(1),
  usd: z.number().min(0).max(10_000).nullable(),
})
export type BudgetCapSet = z.infer<typeof BudgetCapSetSchema>

/**
 * The one parser of a USD amount typed by a person (CLI, setup, wizard, TUI): `none` removes a limit
 * (null); a plain decimal of USD from 0 to 10000 with at most two places is the amount. Anything else
 * (empty, blank, `0x10`, `1e3`, `NaN`, `-1`, `unlimited`) returns a sentence saying what is expected.
 */
export function parseUsdLimit(text: string): number | null | string {
  const value = text.trim().toLowerCase()
  if (value === 'none') return null
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    return 'a number of USD from 0 to 10000 with at most two decimals, or none'
  const n = Number(value)
  return n > 10_000 ? 'a number of USD from 0 to 10000 with at most two decimals, or none' : n
}
