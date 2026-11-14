// Texts and thresholds of the dream service (docs/specs/dreaming.md "Service", ADR-0031 §6, §8): the notices a person reads and
// the gaps the cadence and the budget gate read. Plain values, no I/O.

import { FRONT_TURN_BUDGET_USD } from '../../budget/index.ts'

/** The gap between two started runs of one person (ADR-0031 §6): a run within it is `too-soon`. */
export const TOO_SOON_MS = 20 * 60 * 60 * 1000

/**
 * The notice of a run that stopped on its cost cap (`dreaming.maxUsdPerRun`): the cap in USD and how to raise it. The figure is the
 * setting, never model text (ADR-0031 §8).
 */
export const dreamBudgetTextOf = (maxUsdPerRun: number): string =>
  `The dream run stopped at its cost cap of $${maxUsdPerRun.toFixed(2)}; raise it with /dream settings. Your memory did not change, and the next run reads the same messages.`

/** The notice of a run that failed (the judge reply or the turn, or an unexpected error): counts-free, no model text (ADR-0031 §8). */
export const DREAM_FAILED_TEXT =
  'Memory dreaming failed for this run. Your memory did not change, and the next run reads the same messages.'

/** The notice of an `auto` run that wrote or held back units: counts only, no entry text (ADR-0031 §5, §8). */
export function autoNoticeText(applied: number, staged: number): string {
  if (staged === 0) return `Memory dreaming wrote ${applied} changes to your memory.`
  if (applied === 0)
    return `Memory dreaming held ${staged} changes for review. Nothing in your memory changed for them yet. Run /dream apply to write them.`
  return `Memory dreaming wrote ${applied} changes to your memory and held ${staged} for review. Run /dream apply to write the held ones.`
}

/**
 * The budget under which a run is skipped (`budget-low`): the judge's reservation (`maxUsdPerRun`) plus one whole chat turn
 * (`FRONT_TURN_BUDGET_USD`, the most a front turn reserves). After the judge reserves its cap, a chat turn still fits, so a dream
 * never makes the person's next message fail on the budget. (Before: twice `maxUsdPerRun`, which left 0.15 USD, less than a turn.)
 */
export const budgetLowAt = (maxUsdPerRun: number): number => maxUsdPerRun + FRONT_TURN_BUDGET_USD
