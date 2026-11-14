import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type GuestSessionAudit, GuestSessionAuditSchema } from '@keith/contracts'
import { migrateDatabase, openDatabase, settingsRepo, sqliteActivityStore } from '@keith/db'
import { tool } from 'ai'
import { definePlugin } from 'eharness'
import { type ScriptedModel, scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { personOfSession } from '../../platform/sessions.ts'
import { until } from '../../testing/wait.ts'
import { createBudget } from '../budget/index.ts'
import { createGuestAdmin } from './admin.ts'
import { createEntryGate } from './gate.ts'
import { createGuestBudget } from './guest-budget.ts'
import { createGuestRegistry, type GuestRegistry } from './registry.ts'
import { createGuestSettings } from './settings.ts'

const CATALOG = { 'mock/scripted': { contextWindow: 100_000, pricing: { input: 1, output: 4 } } }
const step = { text: 'ok', usage: { inputTokens: 100, outputTokens: 50 } }
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

function setup(
  over: {
    steps?: Parameters<typeof scriptedModel>[0]
    plugins?: Parameters<typeof createGuestRegistry>[0]['plugins']
    allowTools?: readonly string[]
    graceMs?: number
    settings?: Parameters<ReturnType<typeof createGuestSettings>['set']>[0]
    rolePricing?: () => Promise<{ ref: string | null; priced: boolean }>
  } = {},
) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  closers.push(() => sqlite.close())
  const settings = settingsRepo(sqlite)
  const store = createGuestSettings(settings)
  store.set({ enabled: true, ...over.settings })
  const budget = createBudget({
    generations: { current: () => 0 },
    sqlite,
    settings,
    store: sqliteActivityStore(sqlite),
  })
  const guestBudget = createGuestBudget({ sqlite, store, budget })
  const providers = {
    rolePricing: over.rolePricing ?? (async () => ({ ref: 'mock:scripted', priced: true })),
  }
  const gate = createEntryGate({ store, providers, budget: guestBudget })
  const model: ScriptedModel = scriptedModel(over.steps ?? Array.from({ length: 300 }, () => step))
  const ended: GuestSessionAudit[] = []
  let at = 1_000_000
  const clock = {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
  const registry = createGuestRegistry({
    store,
    gate,
    budget: guestBudget,
    model: async () => model,
    catalog: CATALOG,
    now: clock.now,
    sweepEveryMs: 0,
    graceMs: over.graceMs ?? 5,
    newId: (() => {
      let n = 0
      return () => `g${++n}`
    })(),
    onEnd: (audit) => ended.push(audit),
    ...(over.plugins === undefined ? {} : { plugins: over.plugins }),
    ...(over.allowTools === undefined ? {} : { allowTools: over.allowTools }),
  })
  closers.push(() => registry.close())
  return { sqlite, store, registry, ended, clock, model, gate, guestBudget }
}

const open = async (registry: GuestRegistry) => {
  const r = await registry.open({ zone: 'lan', ipHash: 'abc123def456', clientKind: 'tui' })
  if (!r.ok) throw new Error(`refused: ${r.block}`)
  return r.session
}
const send = (s: Awaited<ReturnType<typeof open>>, text: string) =>
  s.agent.session(s.sessionId).send(text).result

describe('a guest session', () => {
  test('answers, counts its turn and cost, and is no person session', async () => {
    const { registry } = setup()
    const s = await open(registry)
    expect(s.sessionId).toBe('guest:g1')
    expect(personOfSession(s.sessionId)).toBeUndefined()
    const result = await send(s, 'hello')
    expect(result.stop).toBe('complete')
    expect(registry.list()).toMatchObject([
      { id: 'g1', zone: 'lan', ipHash: 'abc123def456', turns: 1 },
    ])
    expect(registry.list()[0]?.costUsd).toBeGreaterThan(0)
    expect(JSON.stringify(registry.list())).not.toContain('hello')
  })

  test('the guest agent sees no tools unless allow-listed', async () => {
    const { registry, model } = setup()
    const s = await open(registry)
    await send(s, 'hi')
    const tools = (model.calls[0]?.tools ?? []) as Array<{ name: string }>
    expect(tools).toEqual([])
    expect(JSON.stringify(model.prompts[0])).toContain('anonymous visitor')
    expect(JSON.stringify(model.prompts[0])).toContain('made public')
    expect(JSON.stringify(model.prompts[0])).not.toMatch(/memory\/|front:|owner's name/i)
  })

  test('tools outside the allow-list are denied; allow-listed ones run and are counted', async () => {
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({
        tools: {
          public_ping: tool({ description: 'p', inputSchema: z.object({}), execute: () => 'pong' }),
          secret_probe: tool({
            description: 's',
            inputSchema: z.object({}),
            execute: () => 'leak',
          }),
        },
      }),
    })
    const { registry, ended, model } = setup({
      plugins: [probe] as never,
      allowTools: ['public_ping'],
      steps: [
        {
          toolCalls: [
            { toolName: 'public_ping', toolCallId: 'a', input: {} },
            { toolName: 'secret_probe', toolCallId: 'b', input: {} },
          ],
        },
        { text: 'done' },
        { text: 'done' },
      ],
    })
    const s = await open(registry)
    await send(s, 'try them')
    const offered = ((model.calls[0]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
    expect(offered).toEqual(['public_ping'])
    await registry.end(s.id, 'closed')
    expect(ended[0]?.tools).toEqual({ public_ping: 1 })
    expect(JSON.stringify(ended[0])).not.toContain('leak')
  })
})

describe('caps', () => {
  test('50 parallel starts yield at most maxConcurrent sessions', async () => {
    const { registry } = setup({ settings: { maxConcurrent: 3 } })
    const results = await Promise.all(
      Array.from({ length: 50 }, () => registry.open({ zone: 'lan', ipHash: 'x' })),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect(registry.size).toBe(3)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.block === 'full')).toBe(true)
  })

  test('a long message is refused without costing a turn or being stored', async () => {
    const { registry } = setup()
    const s = await open(registry)
    const result = await send(s, 'x'.repeat(2049))
    expect(result.stop).toBe('blocked')
    expect(s.info().turns).toBe(0)
    expect(registry.size).toBe(1)
  })

  test('the turn cap ends the session after the last allowed turn, with the audit row', async () => {
    const { registry, ended } = setup({ settings: { maxTurns: 2 } })
    const s = await open(registry)
    expect((await send(s, 'one')).stop).toBe('complete')
    expect((await send(s, 'two')).stop).toBe('complete')
    // between the last answer and the close, a third message is refused
    expect((await send(s, 'three')).stop).toBe('blocked')
    await until(
      'turn-cap end',
      () => registry.size,
      (n) => n === 0,
    )
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      reason: 'turn-cap',
      turns: 2,
      refusals: { 'turn-cap': 1 },
      clientKind: 'tui',
    })
    expect(GuestSessionAuditSchema.safeParse(ended[0]).success).toBe(true)
    expect(registry.get(s.id)).toBeUndefined()
  })

  test('a cost cap stop ends the session with cost-cap', async () => {
    const { registry, ended } = setup({ settings: { dailyUsd: 0.0006 } })
    const s = await open(registry)
    let stop = ''
    for (let i = 0; i < 5 && stop !== 'cost-cap'; i++) stop = (await send(s, 'again')).stop
    expect(stop).toBe('cost-cap')
    await until(
      'cost-cap end',
      () => registry.size,
      (n) => n === 0,
    )
    expect(ended[0]?.reason).toBe('cost-cap')
  })
})

describe('expiry', () => {
  test('idle: no traffic for idleMs ends it; traffic and touch keep it alive', async () => {
    const { registry, clock, ended } = setup({
      settings: { idleMs: 60_000, absoluteMs: 3_600_000 },
    })
    const a = await open(registry)
    const b = await open(registry)
    clock.advance(50_000)
    registry.touch(b.id)
    clock.advance(20_000)
    expect(await registry.sweep()).toBe(1)
    expect(registry.get(a.id)).toBeUndefined()
    expect(registry.get(b.id)).toBeDefined()
    expect(ended.map((e) => e.reason)).toEqual(['idle'])
  })

  test('absolute: busy sessions still end at the absolute lifetime', async () => {
    const { registry, clock, ended } = setup({ settings: { idleMs: 60_000, absoluteMs: 120_000 } })
    const s = await open(registry)
    for (let i = 0; i < 4; i++) {
      clock.advance(40_000)
      registry.touch(s.id)
      await registry.sweep()
    }
    expect(registry.size).toBe(0)
    expect(ended[0]?.reason).toBe('absolute')
  })

  test('the info says when it ends: the sooner of idle and absolute', async () => {
    const { registry } = setup({ settings: { idleMs: 60_000, absoluteMs: 90_000 } })
    const r = await registry.open({ zone: 'lan', ipHash: 'x' })
    expect(r.ok && r.expiresAt).toBe(1_000_000 + 60_000)
  })
})

describe('kill switch, close and restart', () => {
  test('a kill that lands while the entry gate is still reading the price refuses the start (F-023)', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { registry, store, ended, gate, guestBudget } = setup({
      rolePricing: async () => {
        await held
        return { ref: 'mock:scripted', priced: true }
      },
    })
    const admin = createGuestAdmin({
      store,
      providers: { rolePricing: async () => ({ ref: 'mock:scripted', priced: true }) },
      sessions: registry,
      gate,
      budget: guestBudget,
      publicUrl: () => null,
    })
    const pending = registry.open({ zone: 'lan', ipHash: 'abc123def456' })
    expect(await admin.killswitch(true)).toEqual({ ended: 0 })
    release()
    expect(await pending).toEqual({ ok: false, block: 'killed' })
    expect(registry.size).toBe(0)
    expect(ended).toEqual([])
  })

  test('the kill switch ends every session at once and refuses new ones', async () => {
    const { registry, store, ended, gate, guestBudget } = setup()
    const admin = createGuestAdmin({
      store,
      providers: { rolePricing: async () => ({ ref: 'mock:scripted', priced: true }) },
      sessions: registry,
      gate,
      budget: guestBudget,
      publicUrl: () => null,
    })
    await open(registry)
    await open(registry)
    expect(await admin.killswitch(true)).toEqual({ ended: 2 })
    expect(registry.size).toBe(0)
    expect(ended.map((e) => e.reason)).toEqual(['killed', 'killed'])
    expect(await registry.open({ zone: 'lan', ipHash: 'x' })).toEqual({
      ok: false,
      block: 'killed',
    })
  })

  test('disabling guests ends every session; ending one by id works and an unknown id says no', async () => {
    const { registry, store, gate, guestBudget } = setup()
    const admin = createGuestAdmin({
      store,
      providers: { rolePricing: async () => ({ ref: 'mock:scripted', priced: true }) },
      sessions: registry,
      gate,
      budget: guestBudget,
      publicUrl: () => null,
    })
    const a = await open(registry)
    await open(registry)
    expect(await admin.end(a.id)).toEqual({ ended: 1 })
    await expect(admin.end('guest-nope')).rejects.toThrow(/no guest session/)
    const { change } = await admin.set({ enabled: false })
    expect(change.ended).toBe(1)
    expect(registry.size).toBe(0)
  })

  test('a restart loses every session: close ends them as restart and a new registry knows none', async () => {
    const first = setup()
    const s = await open(first.registry)
    await first.registry.close()
    expect(first.ended.map((e) => e.reason)).toEqual(['restart'])
    const second = setup()
    expect(second.registry.get(s.id)).toBeUndefined()
    expect(second.registry.list()).toEqual([])
  })

  test('a session that already ended cannot be ended twice or used', async () => {
    const { registry, ended } = setup()
    const s = await open(registry)
    expect(await registry.end(s.id, 'closed')).toBe(true)
    expect(await registry.end(s.id, 'closed')).toBe(false)
    expect(ended).toHaveLength(1)
    expect(registry.touch(s.id)).toBe(false)
  })
})

describe('nothing durable, memory freed', () => {
  test('a sentinel typed and answered in a session is in no table of the database after it ends', async () => {
    const sentinel = `zq${crypto.randomUUID().replaceAll('-', '')}`
    const reply = `rp${crypto.randomUUID().replaceAll('-', '')}`
    const { registry, sqlite } = setup({
      steps: [{ text: reply, usage: { inputTokens: 5, outputTokens: 5 } }],
    })
    const s = await open(registry)
    expect((await send(s, `my secret is ${sentinel}`)).stop).toBe('complete')
    const dump = (): string => {
      const tables = sqlite
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
      return tables
        .map((t) => JSON.stringify(sqlite.query(`SELECT * FROM "${t.name}"`).all()))
        .join('\n')
    }
    expect(dump()).not.toContain(sentinel) // live
    await registry.end(s.id, 'closed')
    expect(dump()).not.toContain(sentinel)
    expect(dump()).not.toContain(reply)
    for (const table of ['eh_messages', 'eh_state', 'eh_inbox', 'eh_stream_log', 'events']) {
      const row = sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
      expect(row?.n).toBe(0)
    }
  })

  test('the agent is garbage once the session ends (nothing keeps its messages)', async () => {
    const { registry } = setup()
    const probe = async (): Promise<[WeakRef<object>, WeakRef<object>]> => {
      const s = await open(registry)
      await send(s, `hello ${'z'.repeat(50)}`)
      const refs: [WeakRef<object>, WeakRef<object>] = [new WeakRef(s.agent), new WeakRef(s)]
      await registry.end(s.id, 'closed')
      return refs
    }
    // control: a session that is still in the registry is still reachable
    const kept = await open(registry)
    const keptRef = new WeakRef(kept.agent)
    const refs = await probe()
    // a collection may need a few turns of the event loop, more so when the whole suite is running
    for (
      let i = 0;
      i < 40 && (refs[0].deref() !== undefined || refs[1].deref() !== undefined);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      Bun.gc(true)
    }
    expect(refs[0].deref()).toBeUndefined()
    expect(refs[1].deref()).toBeUndefined()
    expect(keptRef.deref()).toBeDefined()
    expect(registry.get(kept.id)).toBe(kept)
  })

  test('the registry, factory and limits import no database, storage or memory module', () => {
    const dir = import.meta.dir
    for (const file of ['registry.ts', 'guest-agent.ts', 'guest-limits.ts']) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const banned of [
        '@keith/db',
        'eharness/sqlite',
        'hippocampus',
        'storage',
        'sqlite',
        // the activity feed's module (`eharness/activity`); the `activityLogs` plugin is passed in, not imported
        "/activity'",
      ]) {
        expect(source.toLowerCase().replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toContain(banned)
      }
    }
  })
})
