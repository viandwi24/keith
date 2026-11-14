/**
 * P16 open verification 3 (docs/plans/done/P16-keith-plugin-layer.md): can a reminder that fires for
 * `recipient` be billed to `creator` by carrying `billTo` on the turn principal? The principal is an
 * open JSON object (eharness spec 05 §2.3); this test follows `{ id, billTo }` through the real eharness
 * paths a scheduled reminder uses, on the production SQLite inbox, and shows what the ledger's `scopes(ctx)` sees.
 * Scripted models, no network.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  migrateDatabase,
  openDatabase,
  sqliteBudgetLedger,
  sqliteInbox,
  sqliteMessages,
  sqliteState,
} from '@keith/db'
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin, type HarnessAgent } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { until } from './testing/wait.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
const BILLED = { id: 'ben', billTo: 'ana' }
const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of closers) await close()
})

interface Seen {
  hook: string
  kind: string | undefined
  principal: unknown
}
function build(steps: Parameters<typeof scriptedModel>[0], over: Record<string, unknown> = {}) {
  const seen: Seen[] = []
  const scopes: unknown[] = []
  const watch = definePlugin({
    name: 'watch',
    setup: () => ({
      tools: {
        ping: tool({ description: 'ping', inputSchema: z.object({}), execute: () => 'pong' }),
      },
      hooks: {
        'turn.prepare': (ctx) => {
          seen.push({ hook: 'turn.prepare', kind: ctx.turn?.kind, principal: ctx.principal })
        },
        'tool.approve': (ctx) => {
          seen.push({ hook: 'tool.approve', kind: ctx.turn?.kind, principal: ctx.principal })
          return { type: 'user-approval' as const, reason: 'ask' }
        },
      },
    }),
  })
  const agent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    plugins: [watch] as never,
    ...over,
  }) as Agent
  closers.push(() => agent.close())
  return { agent, seen, scopes }
}

describe('billTo on the turn principal', () => {
  test('send: ctx.principal keeps every key, billTo included', async () => {
    const { agent, seen } = build([{ text: 'ok' }])
    const session = agent.session('front:ben', { principal: { id: 'ben' } })
    await session.send('hi', { principal: BILLED }).result
    expect(seen.find((s) => s.hook === 'turn.prepare')?.principal).toEqual(BILLED)
  })

  test('park and respond: the continuation runs with the principal of the turn that asked', async () => {
    const { agent, seen } = build([
      { toolCalls: [{ toolName: 'ping', toolCallId: 'p1', input: {} }] },
      { text: 'done' },
    ])
    const session = agent.session('front:ben', { principal: { id: 'ben' } })
    await session.send('ping', { principal: BILLED }).result
    const approval = (await agent.peek('front:ben').pending())?.approvals[0]
    await session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true, actor: { id: 'owner' } }],
    }).result
    const after = seen.filter((s) => s.kind === 'respond')
    expect(after.length).toBeGreaterThan(0)
    for (const s of after) expect(s.principal).toEqual(BILLED)
  })

  test('wake: inject(wake, { principal }) starts the wake turn with the billed principal', async () => {
    const { agent, seen } = build([{ text: 'reminder delivered' }])
    const session = agent.session('front:ben', { principal: { id: 'ben' } })
    const { run } = await session.inject(
      'eh.event',
      { name: 'reminder', text: 'Reminder from ana: call mum', data: { id: 'r1' } },
      { deliver: 'next-turn', wake: true, principal: BILLED },
    )
    await run?.result
    const wake = seen.find((s) => s.hook === 'turn.prepare')
    expect(wake?.kind).toBe('wake')
    expect(wake?.principal).toEqual(BILLED)
  })

  test('enqueue on the durable inbox: another instance drains it with the same principal (the scheduler path)', async () => {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const inbox = sqliteInbox(db)
    const storage = (dead: boolean) => ({
      messages: sqliteMessages(db),
      state: sqliteState(db),
      inbox: {
        ...inbox,
        // a "dead" process never claims, so the item can only be run by the other instance
        claim: async (...a: Parameters<typeof inbox.claim>) => (dead ? [] : inbox.claim(...a)),
      },
    })
    const a = build([{ text: 'never' }], { storage: storage(true), inbox: { pollMs: 20 } })
    const b = build([{ text: 'fired' }], { storage: storage(false), inbox: { pollMs: 20 } })
    const sa = a.agent.session('front:ben', { principal: { id: 'ben' } })
    // a session of B must be open to drain
    b.agent.session('front:ben', { principal: { id: 'ben' } })
    await sa.enqueue('fire: call mum', { principal: BILLED })
    await until('instance B ran the turn', () => b.seen.some((s) => s.hook === 'turn.prepare'))
    expect(b.seen.find((s) => s.hook === 'turn.prepare')?.principal).toEqual(BILLED)
    expect(a.seen).toEqual([])
    // the stored inbox item holds the principal as plain JSON (identifiers only, never a secret)
    db.close()
  })

  test('the ledger scopes(ctx) of the budget config receives the same principal in every turn kind', async () => {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const scopeCalls: Array<{ kind: string | undefined; principal: unknown }> = []
    const budget = {
      maxTurnUsd: 1,
      ledger: {
        adapter: sqliteBudgetLedger(db),
        scopes: (ctx: { principal?: unknown; turn?: { kind?: string } }) => {
          scopeCalls.push({ kind: ctx.turn?.kind, principal: ctx.principal })
          const p = ctx.principal as { id?: string; billTo?: string } | undefined
          return ['global', `person:${p?.billTo ?? p?.id ?? 'none'}`]
        },
      },
    }
    const { agent } = build([{ text: 'a' }, { text: 'b' }], { budget })
    const session = agent.session('front:ben', { principal: { id: 'ben' } })
    await session.send('one', { principal: BILLED }).result
    const { run } = await session.inject(
      'eh.event',
      { name: 'reminder', text: 'x', data: {} },
      { deliver: 'next-turn', wake: true, principal: BILLED },
    )
    await run?.result
    expect(scopeCalls.length).toBeGreaterThan(0)
    for (const c of scopeCalls) expect(c.principal).toEqual(BILLED)
    const spent = db
      .query<{ scope: string }, []>('SELECT DISTINCT scope FROM eh_budget_scope')
      .all()
      .map((r) => r.scope)
      .sort()
    expect(spent).toContain('person:ana')
    expect(spent).not.toContain('person:ben')
    db.close()
  })
})
