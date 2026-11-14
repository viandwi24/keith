import { BUDGET_CHANGED, type BudgetStatus } from '@keith/contracts'
import {
  budgetStatus,
  currentPeriod,
  type SettingsRepo,
  type Sqlite,
  setBudgetLimit,
  sqliteBudgetLedger,
} from '@keith/db'
import type { BudgetConfig, HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { type BudgetRefusal, budgetNotice, trackRefusals } from 'eharness/limits'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import { emit } from '../brain-events/index.ts'
import { createUnpriced, type Unpriced } from './unpriced.ts'

/**
 * The global scope: everyone's spending, all agents, one calendar month (UTC). Its stored value
 * stays `owner` (the name of the MVP's only scope), so ledgers from before P9 keep working.
 */
export const GLOBAL_SCOPE = 'owner'
/** The scope of one person's spending and optional monthly cap. */
export const personScope = (personId: string): string => `person:${personId}`
const PERSON_PREFIX = 'person:'
/** Monthly limit until the owner changes it (P5 decision). */
export const DEFAULT_MONTHLY_LIMIT_USD = 20
/** Cap of one front-agent turn. */
export const FRONT_TURN_BUDGET_USD = 0.5
/** Cap of one worker turn (`WORKER_BUDGET` in cortex reads it: one place for the number). */
export const WORKER_TURN_BUDGET_USD = 1
/** The part of a session id that marks a worker (`front:<id>:agent:<task>`). */
const WORKER_MARK = ':agent:'

export { BUDGET_CHANGED }

/**
 * Whose scope a turn is charged to: the principal's `billTo` (a non-empty string) or else its `id`.
 * Anything else in `billTo` is ignored, so a malformed value can only fall back to the asker.
 */
export function billedPerson(
  principal: { id: string; billTo?: unknown } | undefined,
): string | undefined {
  if (principal === undefined) return undefined
  const to = principal.billTo
  return typeof to === 'string' && to !== '' ? to : principal.id
}

const SEEDED_KEY = 'budget.seeded'

const usd = (n: number): string => String(Number(n.toFixed(4)))

/** What the owner reads when a turn stopped on a budget (English). */
export function budgetText(refusal: BudgetRefusal | undefined, sessionId = ''): string {
  if (refusal === undefined) {
    return `This turn stopped because its cost went over the per-turn limit. Send another message, or ask for a smaller task.`
  }
  const limit = usd(refusal.limitUsd)
  const used = usd(refusal.spentUsd)
  if (refusal.scope.startsWith(PERSON_PREFIX)) {
    if (refusal.spentUsd >= refusal.limitUsd) {
      return `Your monthly cost cap (${limit} USD, set by the owner) is reached (${used} USD used). Ask the owner to raise it, or wait until next month.`
    }
    return `Your remaining monthly cost cap is not enough for one turn: ${used} of ${limit} USD used or reserved, while a turn needs to reserve its cost up front. Ask the owner to raise it, or wait until next month.`
  }
  if (refusal.spentUsd >= refusal.limitUsd) {
    return `The monthly cost limit (${limit} USD) is reached (${used} USD used). Change it with /budget or wait until next month.`
  }
  // not reached yet: a turn reserves up to its own cap first, and the rest of the limit is smaller.
  // A worker's id also starts with `front:`, so the worker test comes first (P24.3.4, F-039).
  const reserve = sessionId.includes(WORKER_MARK)
    ? `, while one worker turn reserves up to ${usd(WORKER_TURN_BUDGET_USD)} USD`
    : sessionId.startsWith('front:')
      ? `, while one turn reserves up to ${usd(FRONT_TURN_BUDGET_USD)} USD`
      : ', while one turn needs to reserve its cost up front'
  return `The remaining monthly cost limit is not enough for one turn: ${used} of ${limit} USD used or reserved${reserve}. Raise the limit with /budget or wait until next month.`
}

export interface BudgetOptions {
  sqlite: Sqlite
  settings: SettingsRepo
  store: ActivityStore
  /** Models that spent without a price (fed by the harness logger). Default: an empty set. */
  unpriced?: Unpriced
  /** The current front generation of each person (ADR-0030 §2): the session the person's events go to. */
  generations: FrontGenerationOf
}

/** One person's cap and spending this month (the ledger row of `person:<id>`). */
export interface PersonBudgetView {
  limitUsd: number | null
  spentUsd: number
  reservedUsd: number
  remainingUsd: number | null
}

export interface Budget {
  /**
   * `budget` config of an agent: the shared ledger plus its own per-turn / per-session caps. A turn
   * reserves against the global scope and the scope of the person of its root session.
   */
  config(caps: { maxTurnUsd: number; maxSessionUsd?: number }): BudgetConfig
  /**
   * `budget` config over scopes the caller names (guest mode: `owner`, `guests`, `guests:day:<date>`), not
   * a person's. The same ledger and refusal tracking as `config`; `scopes` runs once per turn.
   */
  scoped(caps: { maxTurnUsd: number; maxSessionUsd?: number }, scopes: () => string[]): BudgetConfig
  /** Plugin: a turn that stops on a cap leaves a readable notice in the chat. */
  notice(): HarnessPlugin
  /** The global limit and everyone's spending (scope `owner`). */
  status(): BudgetStatus
  /** What one person sees: own spend and cap; remaining is also bounded by the global rest. */
  statusOf(personId: string): BudgetStatus
  /** One person's cap and spending. */
  person(personId: string): PersonBudgetView
  /** Set (or with `null` remove) the monthly limit; emits `budget-changed`. */
  set(limitUsd: number | null): BudgetStatus
  /** Set (or with `null` remove) a person's monthly cap; emits `budget-changed` to that person. */
  setPersonCap(personId: string, usd: number | null): PersonBudgetView
}

/** First instant of the month after the one starting at `periodStart` (UTC). */
const nextMonth = (periodStart: number): number => {
  const d = new Date(periodStart)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/**
 * Budget: the monthly ledger on SQLite, the default global limit (set once, so a limit the owner
 * removed stays removed), optional per-person caps (a person's ledger row is their spending; its
 * limit is the cap), the readable stop notice and the status the TUI shows.
 */
export function createBudget(options: BudgetOptions): Budget {
  const { sqlite, settings, store, generations } = options
  const unpriced = options.unpriced ?? createUnpriced()
  if (settings.get<boolean>(SEEDED_KEY) !== true) {
    setBudgetLimit(sqlite, GLOBAL_SCOPE, DEFAULT_MONTHLY_LIMIT_USD)
    settings.set(SEEDED_KEY, true)
  }
  const refusals = trackRefusals(sqliteBudgetLedger(sqlite))
  const view = (scope: string): PersonBudgetView & { periodStart: number } => {
    const [s] = budgetStatus(sqlite, [scope])
    const limitUsd = s?.limitUsd ?? null
    const spentUsd = s?.spentUsd ?? 0
    const reservedUsd = s?.reservedUsd ?? 0
    return {
      limitUsd,
      spentUsd,
      reservedUsd,
      remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spentUsd - reservedUsd),
      periodStart: s?.periodStart ?? currentPeriod(),
    }
  }
  const toStatus = (scope: string, v: ReturnType<typeof view>): BudgetStatus => ({
    scope,
    unpriced: unpriced.list(),
    limitUsd: v.limitUsd,
    spentUsd: v.spentUsd,
    reservedUsd: v.reservedUsd,
    remainingUsd: v.remainingUsd,
    periodStart: v.periodStart,
    periodEnd: nextMonth(v.periodStart),
  })
  const status = (): BudgetStatus => toStatus(GLOBAL_SCOPE, view(GLOBAL_SCOPE))
  const statusOf = (personId: string): BudgetStatus => {
    const own = toStatus(personScope(personId), view(personScope(personId)))
    const global = view(GLOBAL_SCOPE).remainingUsd
    if (global === null) return own
    return { ...own, remainingUsd: Math.min(own.remainingUsd ?? global, global) }
  }
  const person = (personId: string): PersonBudgetView => {
    const { periodStart: _p, ...rest } = view(personScope(personId))
    return rest
  }
  const capsOf = (caps: { maxTurnUsd: number; maxSessionUsd?: number }) => ({
    maxTurnUsd: caps.maxTurnUsd,
    ...(caps.maxSessionUsd === undefined ? {} : { maxSessionUsd: caps.maxSessionUsd }),
  })
  return {
    scoped: (caps, scopes) => ({
      ...capsOf(caps),
      ledger: { adapter: refusals.ledger, scopes: () => scopes() },
    }),
    config: (caps) => ({
      ...capsOf(caps),
      ledger: {
        adapter: refusals.ledger,
        // the person who pays for the turn: `billTo` when the principal carries one (a reminder fired for
        // its recipient is paid by its creator), else the person who asked (a worker inherits the principal
        // of its parent turn). `billTo` is an accounting key only, never authority (docs/specs/budget.md)
        scopes: (ctx) => {
          const who = billedPerson(ctx.principal)
          return who === undefined ? [GLOBAL_SCOPE] : [GLOBAL_SCOPE, personScope(who)]
        },
      },
    }),
    notice: () =>
      budgetNotice({
        refusals,
        text: (refusal, sessionId) => budgetText(refusal, sessionId),
      }) as HarnessPlugin,
    status,
    statusOf,
    person,
    set(limitUsd) {
      setBudgetLimit(sqlite, GLOBAL_SCOPE, limitUsd)
      const now = status()
      emit(store, BUDGET_CHANGED, null, null, { status: now })
      return now
    },
    setPersonCap(personId, usd) {
      setBudgetLimit(sqlite, personScope(personId), usd)
      // the person's own clients refresh with their view; the owner's feed does not see it
      emit(store, BUDGET_CHANGED, frontSessionId(personId, generations.current(personId)), null, {
        status: statusOf(personId),
      })
      return person(personId)
    },
  }
}
