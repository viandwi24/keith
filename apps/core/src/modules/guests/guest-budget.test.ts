import { afterAll, describe, expect, test } from 'bun:test'
import {
  budgetStatus,
  migrateDatabase,
  openDatabase,
  setBudgetLimit,
  settingsRepo,
  sqliteActivityStore,
  sqliteBudgetLedger,
} from '@keith/db'
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { createBudget, GLOBAL_SCOPE } from '../budget/index.ts'
import { createEntryGate } from './gate.ts'
import { createGuestBudget, GUESTS_SCOPE, guestDayScope } from './guest-budget.ts'
import { createGuestSettings } from './settings.ts'

const closers: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const close of closers) await close()
})

const DAY = Date.UTC(2026, 10, 9, 12)

function setup(now = () => DAY) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  closers.push(() => sqlite.close())
  const settings = settingsRepo(sqlite)
  const budget = createBudget({
    generations: { current: () => 0 },
    sqlite,
    settings,
    store: sqliteActivityStore(sqlite),
  })
  const store = createGuestSettings(settings)
  const guest = createGuestBudget({ sqlite, store, budget, now })
  return { sqlite, store, budget, guest }
}

const spend = (sqlite: ReturnType<typeof setup>['sqlite'], scope: string, usd: number) =>
  sqliteBudgetLedger(sqlite).record({ scopes: [scope], amountUsd: usd, key: `${scope}:${usd}` })

describe('guest scopes and seeding', () => {
  test('a guest turn is charged to owner, guests and today, never a person', () => {
    const { guest } = setup()
    expect(guest.scopes()).toEqual([GLOBAL_SCOPE, GUESTS_SCOPE, 'guests:day:2026-11-09'])
    expect(guestDayScope(Date.UTC(2026, 10, 10, 0, 0, 1))).toBe('guests:day:2026-11-10')
    expect(guest.scopes().some((s) => s.startsWith('person:'))).toBe(false)
  })

  test('seeding gives each scope the limit of the settings; a changed setting is re-seeded', () => {
    const { sqlite, store, guest } = setup()
    const limits = () =>
      budgetStatus(sqlite, [GUESTS_SCOPE, 'guests:day:2026-11-09'], DAY).map((s) => s.limitUsd)
    expect(limits()).toEqual([null, null])
    guest.seed()
    expect(limits()).toEqual([5, 0.5])
    store.set({ dailyUsd: 0.2, monthlyUsd: 3 })
    guest.seed()
    expect(limits()).toEqual([3, 0.2])
  })

  test('a scope without a limit refuses entry until seeded (it would accept any spending)', () => {
    const { guest } = setup()
    expect(guest.block()).toBe('no-limit')
    guest.seed()
    expect(guest.block()).toBeNull()
  })

  test('the daily scope of a new day is a fresh scope with its own seeded limit', () => {
    let at = DAY
    const { sqlite, guest } = setup(() => at)
    guest.seed()
    spend(sqlite, 'guests:day:2026-11-09', 0.5)
    expect(guest.block()).toBe('daily-cap')
    at = DAY + 86_400_000
    expect(guest.block()).toBe('no-limit')
    guest.seed()
    expect(guest.block()).toBeNull()
  })
})

describe('entry blocks on money', () => {
  test('the monthly cap blocks, and so does the owner floor of 25 percent', () => {
    const { sqlite, budget, guest } = setup()
    guest.seed()
    spend(sqlite, GUESTS_SCOPE, 5)
    expect(guest.block()).toBe('monthly-cap')

    const other = setup()
    other.guest.seed()
    other.budget.set(10)
    spend(other.sqlite, GLOBAL_SCOPE, 7.4) // 26% left
    expect(other.guest.block()).toBeNull()
    spend(other.sqlite, GLOBAL_SCOPE, 0.2) // 24% left
    expect(other.guest.block()).toBe('owner-floor')
    expect(other.guest.view().ownerRemaining).toBeCloseTo(0.24, 5)
    expect(budget.status().limitUsd).toBe(20)
  })

  test('an owner with no global limit is never floored', () => {
    const { budget, guest } = setup()
    budget.set(null)
    guest.seed()
    expect(guest.block()).toBeNull()
    expect(guest.view().ownerRemaining).toBeNull()
  })

  test('the status view reads limit, spent and remaining of both guest scopes', () => {
    const { sqlite, guest } = setup()
    guest.seed()
    spend(sqlite, 'guests:day:2026-11-09', 0.125)
    expect(guest.view().daily).toEqual({
      scope: 'guests:day:2026-11-09',
      limitUsd: 0.5,
      spentUsd: 0.125,
      remainingUsd: 0.375,
    })
  })
})

describe('the entry gate order', () => {
  const providers = (ref: string | null, priced: boolean) => ({
    rolePricing: async () => ({ ref, priced }),
  })
  test('killed, disabled, no model, unpriced, money, then full; open when nothing blocks', async () => {
    const { store, guest } = setup()
    let open = 0
    const gate = (ref: string | null, priced: boolean) =>
      createEntryGate({
        store,
        providers: providers(ref, priced),
        budget: guest,
      })
    expect(await gate('a:b', true).block(open)).toBe('disabled')
    store.set({ enabled: true })
    expect(await gate(null, false).block(open)).toBe('no-model')
    expect(await gate('a:b', false).block(open)).toBe('unpriced-model')
    expect(await gate('a:b', true).block(open)).toBeNull() // seeds the scopes itself
    open = 3
    expect(await gate('a:b', true).block(open)).toBe('full')
    store.setKilled(true)
    expect(await gate('a:b', true).block(open)).toBe('killed')
  })
})

describe('a real guest turn', () => {
  test('is reserved on owner, guests and the day scope only, and the day cap stops it', async () => {
    const { sqlite, store, guest } = setup(() => Date.now())
    store.set({ dailyUsd: 0.001 })
    const step = { text: 'a', usage: { inputTokens: 100, outputTokens: 50 } }
    const agent = defineHarnessAgent({
      id: 'guest',
      model: scriptedModel([step, step, step, step], { provider: 'scripted', modelId: 'm' }),
      models: { 'scripted/m': { contextWindow: 100_000, pricing: { input: 1, output: 4 } } },
      settings: { maxOutputTokens: 100 },
      budget: guest.config(),
    }) as HarnessAgent<never>
    closers.push(() => agent.close())
    const session = agent.session('guest:one')
    const first = await session.send('one').result
    expect(first.stop).toBe('complete')
    const scopesUsed = sqlite
      .query<{ scopes: string }, []>('SELECT scopes FROM eh_budget_reservation')
      .all()
      .map((r) => JSON.parse(r.scopes) as string[])
    expect(scopesUsed.length).toBeGreaterThan(0)
    for (const s of scopesUsed) expect(s).toEqual(guest.scopes())
    const rows = sqlite
      .query<{ scope: string }, []>('SELECT DISTINCT scope FROM eh_budget_scope')
      .all()
      .map((r) => r.scope)
    expect(rows.some((r) => r.startsWith('person:'))).toBe(false)
    // the limit was seeded before the first reservation, so the tiny day cap refuses a later turn
    let stop = first.stop
    for (let i = 0; i < 3 && stop !== 'cost-cap'; i++)
      stop = (await session.send('again').result).stop
    expect(stop).toBe('cost-cap')
  })
})

describe('keeps the global scope limit intact', () => {
  test('setBudgetLimit on a guest scope does not touch the owner scope', () => {
    const { sqlite, budget } = setup()
    setBudgetLimit(sqlite, GUESTS_SCOPE, 1)
    expect(budget.status().limitUsd).toBe(20)
  })
})

describe('the status peek (P24.5.2)', () => {
  test('peekBlock reads the limits the settings name and writes no ledger limit; spending still refuses', () => {
    const { sqlite, guest } = setup()
    const limits = () =>
      budgetStatus(sqlite, [GUESTS_SCOPE, 'guests:day:2026-11-09'], DAY).map((s) => s.limitUsd)
    expect(guest.peekBlock()).toBeNull()
    expect(limits()).toEqual([null, null])
    spend(sqlite, GUESTS_SCOPE, 5)
    expect(guest.peekBlock()).toBe('monthly-cap')
    expect(limits()).toEqual([null, null])
  })
})
