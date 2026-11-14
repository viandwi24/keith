import type { GuestBlock, GuestStatus } from '@keith/contracts'
import { GUEST_LIMITS } from '@keith/contracts'
import { budgetStatus, type Sqlite, setBudgetLimit } from '@keith/db'
import type { BudgetConfig } from 'eharness'
import { type Budget, GLOBAL_SCOPE } from '../budget/index.ts'
import type { GuestSettingsStore } from './settings.ts'

/** The guests' month: everything guests spend, on top of the owner's global scope. */
export const GUESTS_SCOPE = 'guests'
/** The guests' day (UTC). The ledger's period is the month, so a new date is simply a new scope. */
export const guestDayScope = (now: number): string =>
  `${GUESTS_SCOPE}:day:${new Date(now).toISOString().slice(0, 10)}`

/** Largest cost of one guest turn (it can never pass the session cap either). */
export const GUEST_TURN_USD = 0.05

export interface GuestBudgetOptions {
  sqlite: Sqlite
  store: GuestSettingsStore
  budget: Budget
  now?: () => number
}

export interface GuestBudget {
  /** The three scopes a guest turn is charged to, today: `owner`, `guests`, `guests:day:<date>`. Never a person scope. */
  scopes(): string[]
  /**
   * Make the ledger limits of the guest scopes equal the settings (`monthlyUsd`, `dailyUsd`). A ledger scope
   * **without a limit accepts any spending**, so this runs before a session opens and at the start of every turn.
   */
  seed(): void
  /** `budget` config of a guest agent: the three scopes, the per-turn cap and the per-session cap (`sessionUsd`). */
  config(): BudgetConfig
  /** The first budget reason entry is refused (`no-limit`, `owner-floor`, `daily-cap`, `monthly-cap`), or null. Reads only; call `seed()` first. */
  block(): GuestBlock | null
  /**
   * The same answer read without seeding: the limits are the settings' own, the spending is the ledger's. Writes
   * nothing, so `GET /guest/status` can call it (guests.md, Limits).
   */
  peekBlock(): GuestBlock | null
  view(): GuestStatus['budget']
}

/** Guest money: scopes, seeded limits, the owner floor and what the owner reads (docs/specs/budget.md, guests.md). */
export function createGuestBudget(options: GuestBudgetOptions): GuestBudget {
  const { sqlite, store, budget } = options
  const now = options.now ?? Date.now
  const scopes = (): string[] => [GLOBAL_SCOPE, GUESTS_SCOPE, guestDayScope(now())]
  const wanted = (): Array<[string, number]> => {
    const settings = store.get()
    return [
      [GUESTS_SCOPE, settings.monthlyUsd],
      [guestDayScope(now()), settings.dailyUsd],
    ]
  }
  const seed = (): void => {
    for (const [scope, limit] of wanted()) {
      const [row] = budgetStatus(sqlite, [scope], now())
      if (row?.limitUsd !== limit) setBudgetLimit(sqlite, scope, limit)
    }
  }
  const read = (scope: string): GuestStatus['budget']['monthly'] => {
    const [row] = budgetStatus(sqlite, [scope], now())
    const limitUsd = row?.limitUsd ?? null
    const spentUsd = row?.spentUsd ?? 0
    const reservedUsd = row?.reservedUsd ?? 0
    return {
      scope,
      limitUsd,
      spentUsd,
      remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spentUsd - reservedUsd),
    }
  }
  const reasonOf = (
    monthly: GuestStatus['budget']['monthly'],
    daily: GuestStatus['budget']['monthly'],
  ): GuestBlock | null => {
    if (monthly.limitUsd === null || daily.limitUsd === null) return 'no-limit'
    const floor = ownerRemaining()
    if (floor !== null && floor < GUEST_LIMITS.ownerFloor) return 'owner-floor'
    if ((daily.remainingUsd ?? 0) <= 0) return 'daily-cap'
    if ((monthly.remainingUsd ?? 0) <= 0) return 'monthly-cap'
    return null
  }
  const ownerRemaining = (): number | null => {
    const owner = budget.status()
    if (owner.limitUsd === null || owner.remainingUsd === null) return null
    return owner.limitUsd === 0 ? 0 : Math.min(1, owner.remainingUsd / owner.limitUsd)
  }
  return {
    scopes,
    seed,
    config() {
      const { sessionUsd } = store.get()
      return budget.scoped(
        { maxTurnUsd: Math.min(sessionUsd, GUEST_TURN_USD), maxSessionUsd: sessionUsd },
        () => {
          seed()
          return scopes()
        },
      )
    },
    block() {
      return reasonOf(read(GUESTS_SCOPE), read(guestDayScope(now())))
    },
    peekBlock() {
      const settings = store.get()
      const withLimit = (scope: string, limitUsd: number): GuestStatus['budget']['monthly'] => {
        const [row] = budgetStatus(sqlite, [scope], now())
        const spentUsd = row?.spentUsd ?? 0
        const reservedUsd = row?.reservedUsd ?? 0
        return {
          scope,
          limitUsd,
          spentUsd,
          remainingUsd: Math.max(0, limitUsd - spentUsd - reservedUsd),
        }
      }
      return reasonOf(
        withLimit(GUESTS_SCOPE, settings.monthlyUsd),
        withLimit(guestDayScope(now()), settings.dailyUsd),
      )
    },
    view() {
      return {
        monthly: read(GUESTS_SCOPE),
        daily: read(guestDayScope(now())),
        ownerRemaining: ownerRemaining(),
      }
    },
  }
}
