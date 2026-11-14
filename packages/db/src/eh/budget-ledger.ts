// BudgetLedger from `eharness/sqlite`, plus Keith's own limit setter and read-only status.

import type { BudgetLedger } from 'eharness'
import {
  sqliteBudgetLedger as packageBudgetLedger,
  setBudgetLimit as packageSetBudgetLimit,
} from 'eharness/sqlite'
import { driverOf } from './driver.ts'
import type { Sqlite } from './sql.ts'

/** First instant of the current calendar month in UTC (epoch ms). */
export function currentPeriod(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** Set (or clear with `null`) the limit of a scope from the current month on. */
export function setBudgetLimit(sqlite: Sqlite, scope: string, limitUsd: number | null): void {
  packageSetBudgetLimit(driverOf(sqlite), scope, limitUsd)
}

/** `BudgetLedger` of `eharness/sqlite` on `eh_budget_*` (spec 12 §4.1; ADR-0012). */
export const sqliteBudgetLedger = (sqlite: Sqlite): BudgetLedger =>
  packageBudgetLedger(driverOf(sqlite))

export interface BudgetScopeStatus {
  scope: string
  /** null = no limit. */
  limitUsd: number | null
  /** Committed and recorded spending this month. */
  spentUsd: number
  /** Open, unexpired reservations this month. */
  reservedUsd: number
  /** First instant of the month (UTC), epoch ms. */
  periodStart: number
}

/** Read-only view of scopes for the current month (what `check` sums, without the ok flag). */
export function budgetStatus(
  sqlite: Sqlite,
  scopes: readonly string[],
  now: number = Date.now(),
): BudgetScopeStatus[] {
  const periodStart = currentPeriod(now)
  return [...new Set(scopes)].map((scope) => {
    const limit = sqlite
      .query<{ limit_usd: string | null }, [string]>(
        'SELECT limit_usd FROM eh_budget_scope WHERE scope = ? ORDER BY period_start DESC LIMIT 1',
      )
      .get(scope)
    const spent = sqlite
      .query<{ spent_usd: string }, [string, number]>(
        'SELECT spent_usd FROM eh_budget_scope WHERE scope = ? AND period_start = ?',
      )
      .get(scope, periodStart)
    const open = sqlite
      .query<{ total: number }, [number, number, string]>(
        `SELECT coalesce(sum(CAST(r.amount_usd AS REAL)), 0) AS total FROM eh_budget_reservation AS r
         WHERE r.state = 'open' AND r.expires_at > ? AND r.period_start = ?
           AND EXISTS (SELECT 1 FROM json_each(r.scopes) AS j WHERE j.value = ?)`,
      )
      .get(now, periodStart, scope)
    return {
      scope,
      limitUsd: limit?.limit_usd == null ? null : Number(limit.limit_usd),
      spentUsd: Number(spent?.spent_usd ?? 0),
      reservedUsd: Number(open?.total ?? 0),
      periodStart,
    }
  })
}
