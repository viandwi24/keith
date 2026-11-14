import { afterAll, describe, expect, test } from 'bun:test'
import {
  migrateDatabase,
  openDatabase,
  settingsRepo,
  sqliteActivityStore,
  sqliteMessages,
  sqliteState,
} from '@keith/db'
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { billedPerson, budgetText, createBudget, GLOBAL_SCOPE, personScope } from './budget.ts'
import { createUnpriced, routeUnpriced, UNPRICED_CODE } from './unpriced.ts'

const closers: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const close of closers) await close()
})

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  closers.push(() => sqlite.close())
  const budget = createBudget({
    generations: { current: () => 0 },
    sqlite,
    settings: settingsRepo(sqlite),
    store: sqliteActivityStore(sqlite),
  })
  return { sqlite, budget }
}

describe('billedPerson', () => {
  test('billTo wins, else the id; a malformed billTo falls back to the asker', () => {
    expect(billedPerson({ id: 'ben', billTo: 'ana' })).toBe('ana')
    expect(billedPerson({ id: 'ben' })).toBe('ben')
    expect(billedPerson({ id: 'ben', billTo: '' })).toBe('ben')
    expect(billedPerson({ id: 'ben', billTo: 42 })).toBe('ben')
    expect(billedPerson(undefined)).toBeUndefined()
  })
})

describe('budget scopes read billTo', () => {
  test('scopes(ctx) charges the global scope and the billed person', () => {
    const { budget } = setup()
    const scopes = budget.config({ maxTurnUsd: 1 }).ledger?.scopes as (ctx: unknown) => string[]
    expect(scopes({ principal: { id: 'ben', billTo: 'ana' } })).toEqual([
      GLOBAL_SCOPE,
      personScope('ana'),
    ])
    expect(scopes({ principal: { id: 'ben' } })).toEqual([GLOBAL_SCOPE, personScope('ben')])
    expect(scopes({})).toEqual([GLOBAL_SCOPE])
  })

  test('a real turn for ben billed to ana reserves under person:ana and never person:ben', async () => {
    const { sqlite, budget } = setup()
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([{ text: 'a' }, { text: 'b' }]),
      contextWindow: 100_000,
      storage: { messages: sqliteMessages(sqlite), state: sqliteState(sqlite) },
      budget: budget.config({ maxTurnUsd: 1 }),
    }) as HarnessAgent<never>
    closers.push(() => agent.close())
    const session = agent.session('front:ben', { principal: { id: 'ben' } })
    await session.send('one', { principal: { id: 'ben', billTo: 'ana' } }).result
    await session.send('two', { principal: { id: 'ben' } }).result
    const scopes = sqlite
      .query<{ scope: string }, []>('SELECT DISTINCT scope FROM eh_budget_scope')
      .all()
      .map((r) => r.scope)
    expect(scopes).toContain('person:ana')
    expect(scopes).toContain('person:ben') // the second turn, no billTo
    // the first turn alone never touched ben: a ledger row per reservation names its scopes
    const reservations = sqlite
      .query<{ scopes: string }, []>('SELECT scopes FROM eh_budget_reservation ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.scopes) as string[])
    expect(reservations[0]).toEqual([GLOBAL_SCOPE, 'person:ana'])
    expect(reservations[1]).toEqual([GLOBAL_SCOPE, 'person:ben'])
  })
})

describe('unpriced models (P24.4.3, ADR-0027 §23)', () => {
  const warning = (model: string) => ({
    code: UNPRICED_CODE,
    message: `No pricing for model '${model}' in \`models\`; its usage does not count toward the budget.`,
    details: { model },
  })
  const fakeLogger = () => {
    const lines: string[] = []
    const log = (level: string) => (message: string, _data?: Record<string, unknown>) =>
      lines.push(`${level} ${message}`)
    return {
      lines,
      logger: {
        debug: log('debug'),
        info: log('info'),
        warn: log('warn'),
        error: log('error'),
      },
    }
  }

  test('an unpriced warning from the harness logger lands in budget.get, once per model, and is still logged', () => {
    const { sqlite } = setup()
    const unpriced = createUnpriced()
    const budget = createBudget({
      generations: { current: () => 0 },
      sqlite,
      settings: settingsRepo(sqlite),
      store: sqliteActivityStore(sqlite),
      unpriced,
    })
    const { lines, logger } = fakeLogger()
    const harness = routeUnpriced(logger, unpriced)
    harness.warn(warning('openrouter:x/cheap').message, warning('openrouter:x/cheap'))
    harness.warn(warning('openrouter:x/cheap').message, warning('openrouter:x/cheap'))
    harness.warn('other warning', { code: 'W_OTHER' })
    expect(budget.status().unpriced).toEqual(['openrouter:x/cheap'])
    expect(budget.statusOf('ben').unpriced).toEqual(['openrouter:x/cheap'])
    expect(lines.filter((l) => l.startsWith('warn No pricing')).length).toBe(2)
  })

  test('without a registry the list is empty, and a model with no price is not counted as spend', () => {
    const { budget } = setup()
    expect(budget.status().unpriced).toEqual([])
  })
})

describe('budget stop text names the cap of the turn that stopped (P24.3.4, F-039)', () => {
  const refusal = {
    scope: GLOBAL_SCOPE,
    limitUsd: 0.7,
    spentUsd: 0,
    reservedUsd: 0,
  } as never

  test('a front turn is said to reserve 0.5 USD', () => {
    expect(budgetText(refusal, 'front:ana')).toContain('one turn reserves up to 0.5 USD')
  })

  test('a worker of the same person is said to reserve 1 USD, not the front figure', () => {
    const text = budgetText(refusal, 'front:ana:agent:c1')
    expect(text).toContain('one worker turn reserves up to 1 USD')
    expect(text).not.toContain('0.5')
  })

  test('a session that is neither names no cap', () => {
    expect(budgetText(refusal, 'other')).toContain('one turn needs to reserve its cost up front')
  })
})
