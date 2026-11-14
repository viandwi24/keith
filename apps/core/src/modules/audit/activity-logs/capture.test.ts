import { afterAll, describe, expect, test } from 'bun:test'
import { type LogsSettings, LogsSettingsSchema } from '@keith/contracts'
import {
  activityLogsRepo,
  migrateDatabase,
  openDatabase,
  settingsRepo,
  sqliteLock,
  sqliteMessages,
  sqliteState,
} from '@keith/db'
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin, type ModelCallEvent } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { frontSessionId, frontSessionOptions } from '../../../platform/sessions.ts'
import { activityLogs, type CaptureRecord, toRecord } from './capture.ts'
import { unpack } from './pack.ts'
import { createLogQueue } from './queue.ts'
import { createActivityLogSettings } from './settings.ts'

const DEFAULTS: LogsSettings = LogsSettingsSchema.parse({})
const closers: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const close of closers) await close()
})

/** Polls until `check` holds (the writer drains on a timer, after the turn). */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function setup(sink?: (batch: CaptureRecord[]) => void) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  closers.push(() => sqlite.close())
  const repo = activityLogsRepo(sqlite)
  const settings = createActivityLogSettings(settingsRepo(sqlite))
  const queue = createLogQueue<CaptureRecord>({
    sink: sink ?? ((batch) => void repo.insertCalls(batch)),
    intervalMs: 5,
  })
  const lock = sqliteLock(sqlite, { owner: 'capture-test' })
  return { sqlite, repo, settings, queue, lock }
}

function pingPlugin() {
  return definePlugin({
    name: 'ping-tool',
    setup: () => ({
      tools: {
        ping: tool({ description: 'ping', inputSchema: z.object({}), execute: () => 'pong' }),
      },
    }),
  })
}

function agentWith(
  sqlite: ReturnType<typeof openDatabase>,
  steps: Parameters<typeof scriptedModel>[0],
  plugin: ReturnType<typeof activityLogs>,
) {
  const agent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage: { messages: sqliteMessages(sqlite), state: sqliteState(sqlite) },
    plugins: [pingPlugin(), plugin] as never,
  })
  closers.push(() => agent.close())
  return agent
}

/** A synthetic model.call event (compaction, flush, room, guest, ...). */
function event(over: Partial<ModelCallEvent> = {}): ModelCallEvent {
  return {
    id: '0190f0a0-0000-7000-8000-000000000001',
    model: { provider: 'openrouter', modelId: 'anthropic/claude-x' },
    startedAt: '2026-11-11T10:00:00.000Z',
    durationMs: 820,
    firstChunkMs: 210,
    status: 'ok',
    finishReason: 'stop',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 15, reasoningTokens: 5 },
    },
    request: { options: { prompt: [{ role: 'user', content: 'summarize' }] } },
    response: {
      id: 'gen-1',
      modelId: 'anthropic/claude-x',
      headers: { 'x-id': '1' },
      body: { ok: true },
    },
    output: { text: 'a summary', reasoning: '', toolCalls: [] },
    kind: 'compaction',
    sessionId: 'front:ana',
    turnId: 'turn-1',
    costUsd: 0.0123,
    costSource: 'estimate',
    upstreamProvider: 'Anthropic',
    ...over,
  } as ModelCallEvent
}

describe('activity-logs capture on a real agent turn', () => {
  test('a two-step turn writes one chat session and two step calls with figures', async () => {
    const { sqlite, repo, settings, queue, lock } = setup()
    closers.push(() => queue.stop())
    const agent = agentWith(
      sqlite,
      [
        {
          toolCalls: [{ toolName: 'ping', input: {} }],
          usage: { inputTokens: 40, outputTokens: 6 },
        },
        { text: 'pong received', usage: { inputTokens: 55, outputTokens: 4 } },
      ],
      activityLogs({ queue, settings }),
    )
    const id = frontSessionId('ana', 0)
    const session = agent.session(id, frontSessionOptions(id, lock))
    await session.send('ping for me').result
    await until(() => (repo.getSession(id)?.calls ?? 0) === 2 && queue.size === 0)

    const rows = repo.listSessions().sessions
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, kind: 'chat', personId: 'ana', app: 'Front', calls: 2 })

    const calls = repo.listCalls(id)
    expect(calls.map((c) => c.kind)).toEqual(['step', 'step'])
    expect(calls.map((c) => c.stepIndex)).toEqual([0, 1])
    expect(calls.map((c) => c.trigger)).toEqual(['send', 'send'])
    expect(calls[0]?.turnId).toBeTruthy()
    expect(calls[0]?.turnId).toBe(calls[1]?.turnId)
    expect(calls[0]).toMatchObject({ tokensIn: 40, tokensOut: 6, status: 'ok', provider: 'mock' })
    expect(calls[1]).toMatchObject({ tokensIn: 55, tokensOut: 4, status: 'ok' })
    expect(calls[1]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(calls[0]?.bodyState).toBe('stored')
    expect(repo.getBodies(calls[0]?.id ?? '')?.request).not.toBeNull()
  })

  test('a flush outside a turn (the /new reset) is captured as kind flush with trigger null; the turn before it as send', async () => {
    const { sqlite, repo, settings, queue, lock } = setup()
    closers.push(() => queue.stop())
    // the flush share of a compaction.before hook, like the memory plugin's (spec 06 §5.2a)
    const flushHook = definePlugin({
      name: 'flush-share',
      setup: () => ({
        hooks: { 'compaction.before': () => ({ flush: { prompt: 'save what matters' } }) },
      }),
    })
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([
        { text: 'noted', usage: { inputTokens: 30, outputTokens: 3 } },
        { text: 'nothing to save', usage: { inputTokens: 50, outputTokens: 4 } },
      ]),
      contextWindow: 100_000,
      storage: { messages: sqliteMessages(sqlite), state: sqliteState(sqlite) },
      plugins: [flushHook, activityLogs({ queue, settings })],
    })
    closers.push(() => agent.close())
    const id = frontSessionId('ana', 0)
    const session = agent.session(id, frontSessionOptions(id, lock))
    await session.send('remember the blue door').result
    expect(await session.flush()).toEqual({ status: 'flushed' })
    await until(() => (repo.getSession(id)?.calls ?? 0) === 2 && queue.size === 0)

    const calls = repo.listCalls(id)
    expect(calls.map((c) => c.kind)).toEqual(['step', 'flush'])
    // a call inside a turn carries its kind; the flush runs outside any turn, so ctx.turn is absent at runtime
    expect(calls.map((c) => c.trigger)).toEqual(['send', null])
  })

  test('a secret typed into the prompt is redacted in the stored request', async () => {
    const { sqlite, repo, settings, queue, lock } = setup()
    closers.push(() => queue.stop())
    const agent = agentWith(sqlite, [{ text: 'noted' }], activityLogs({ queue, settings }))
    // built at runtime: gitleaks would flag the literal
    const KEY = ['sk', 'or', 'v1', 'K3ph9Zq2Lm8Rt5Wx1Yb7Nd4Gs6Hj0Fa'].join('-')
    const id = frontSessionId('ben', 0)
    const session = agent.session(id, frontSessionOptions(id, lock))
    await session.send(`my openrouter key is ${KEY}, keep it`).result
    await until(() => repo.getSession(id)?.calls === 1 && queue.size === 0)

    const call = repo.listCalls(id)[0]
    const stored = repo.getBodies(call?.id ?? '')
    const text = JSON.stringify(unpack(stored?.request as Uint8Array<ArrayBuffer>))
    expect(text).toContain('[redacted:secret]')
    expect(text).not.toContain(KEY)
  })

  test('a throwing store does not fail the turn', async () => {
    const errors: unknown[] = []
    const { sqlite, settings, lock } = setup()
    const queue = createLogQueue<CaptureRecord>({
      sink: () => {
        throw new Error('store down')
      },
      onError: (error) => errors.push(error),
      intervalMs: 0,
    })
    closers.push(() => queue.stop())
    const agent = agentWith(sqlite, [{ text: 'still fine' }], activityLogs({ queue, settings }))
    const id = frontSessionId('ana', 0)
    const session = agent.session(id, frontSessionOptions(id, lock))
    await session.send('hello').result
    expect(JSON.stringify(await session.messages())).toContain('still fine')
    await until(() => errors.length > 0)
  })

  test('a store that never settles does not hold the turn (the hook never awaits it)', async () => {
    const { sqlite, settings, lock } = setup()
    const queue = createLogQueue<CaptureRecord>({
      sink: () => new Promise<void>(() => {}),
      intervalMs: 0,
    })
    const agent = agentWith(sqlite, [{ text: 'not blocked' }], activityLogs({ queue, settings }))
    const id = frontSessionId('ana', 0)
    const session = agent.session(id, frontSessionOptions(id, lock))
    const run = await session.send('hello').result
    expect(run.stop).toBeDefined()
    expect(JSON.stringify(await session.messages())).toContain('not blocked')
  })

  test('a room turn records the session under the room and the speaker on the call', async () => {
    const { sqlite, repo, settings, queue, lock } = setup()
    closers.push(() => queue.stop())
    const agent = agentWith(sqlite, [{ text: 'hi room' }], activityLogs({ queue, settings }))
    const id = 'room:r1:g0'
    const session = agent.session(id, { lock, principal: { id: 'ana' } })
    await session.send('hi').result
    await until(() => repo.getSession(id)?.calls === 1 && queue.size === 0)
    expect(repo.getSession(id)).toMatchObject({
      kind: 'room',
      roomId: 'r1',
      personId: null,
      app: 'Room',
    })
    expect(repo.listCalls(id)[0]?.speakerId).toBe('ana')
  })
})

describe('toRecord', () => {
  const ctx = { principalId: 'ana', turnKind: 'send' }

  test('a compaction call maps figures, cost, upstream provider and the turn kind', () => {
    const record = toRecord(event(), ctx, DEFAULTS)
    expect(record?.session).toEqual({
      id: 'front:ana',
      kind: 'chat',
      personId: 'ana',
      roomId: null,
      app: 'Front',
    })
    expect(record?.call).toMatchObject({
      kind: 'compaction',
      trigger: 'send',
      turnId: 'turn-1',
      startedAt: Date.parse('2026-11-11T10:00:00.000Z'),
      durationMs: 820,
      firstChunkMs: 210,
      status: 'ok',
      finishReason: 'stop',
      modelId: 'anthropic/claude-x',
      provider: 'openrouter',
      upstreamProvider: 'Anthropic',
      tokensIn: 100,
      tokensOut: 20,
      cacheRead: 30,
      cacheWrite: null,
      reasoning: 5,
      costMicro: 12_300,
      costSource: 'estimate',
      fallbackNote: null,
      errorName: null,
      bodyState: 'stored',
      speakerId: null,
    })
    expect(record?.bodies).toBeDefined()
  })

  test('a flush call with no turn has trigger null; a missing cost stays null', () => {
    // no turn id, no cost: the event without those keys (exactOptionalPropertyTypes)
    const { costUsd: _cost, costSource: _source, turnId: _turn, ...bare } = event()
    const record = toRecord(
      { ...bare, kind: 'flush' } as ModelCallEvent,
      { principalId: 'ana' },
      DEFAULTS,
    )
    expect(record?.call).toMatchObject({
      kind: 'flush',
      trigger: null,
      turnId: null,
      costMicro: null,
      costSource: null,
    })
  })

  test('a key echoed in a provider error message is redacted before it is stored', () => {
    // built at runtime: a key-shaped literal would trip the secret scanner
    const key = ['sk', 'or', 'v1', 'Q'.repeat(48)].join('-')
    const record = toRecord(
      event({
        status: 'error',
        error: { name: 'APICallError', message: `Incorrect API key provided: ${key}` },
      } as never),
      { principalId: 'ana' },
      DEFAULTS,
    )
    expect(record?.call.errorMessage).toContain('Incorrect API key provided')
    expect(record?.call.errorMessage).not.toContain(key)
    expect(record?.call.errorMessage).not.toContain('Q'.repeat(20))
  })

  test('an error call keeps its name and message', () => {
    const record = toRecord(
      event({ status: 'error', error: { name: 'APICallError', message: 'rate limited' } }),
      ctx,
      DEFAULTS,
    )
    expect(record?.call).toMatchObject({
      status: 'error',
      errorName: 'APICallError',
      errorMessage: 'rate limited',
    })
  })

  test('a dream judge takes the person from the principal; an aux call from its id', () => {
    const dream = toRecord(event({ sessionId: 'dream-judge:0190-uuid' }), ctx, DEFAULTS)
    expect(dream?.session).toMatchObject({ kind: 'dream', personId: 'ana', app: 'Dreaming' })
    const aux = toRecord(event({ sessionId: 'aux:web-search:ben' }), ctx, DEFAULTS)
    expect(aux?.session).toMatchObject({ kind: 'aux', personId: 'ben', app: 'Helper' })
  })

  test('a guest session keeps no bodies unless guestBodies is on', () => {
    const guest = event({ sessionId: 'guest:x7k2' })
    const off = toRecord(guest, ctx, DEFAULTS)
    expect(off?.call.bodyState).toBe('off')
    expect(off?.bodies).toBeUndefined()
    const on = toRecord(guest, ctx, { ...DEFAULTS, guestBodies: true })
    expect(on?.call.bodyState).toBe('stored')
    expect(on?.session.personId).toBeNull()
  })

  test('captureBodies off stores figures only', () => {
    const record = toRecord(event(), ctx, { ...DEFAULTS, captureBodies: false })
    expect(record?.call.bodyState).toBe('off')
    expect(record?.call.requestBytes).toBeGreaterThan(0)
    expect(record?.bodies).toBeUndefined()
  })

  test('a body over maxBodyBytes is cut and marked truncated', () => {
    const big = event({ output: { text: 'x'.repeat(40_000), reasoning: '', toolCalls: [] } })
    const record = toRecord(big, ctx, { ...DEFAULTS, maxBodyBytes: 16 * 1024 })
    expect(record?.call.bodyState).toBe('truncated')
    const output = unpack(record?.bodies?.output as Uint8Array<ArrayBuffer>)
    expect(JSON.stringify(output).length).toBeLessThan(40_000)
  })

  test('an unmatched session id is not captured', () => {
    expect(toRecord(event({ sessionId: 'weird:thing' }), ctx, DEFAULTS)).toBeUndefined()
  })

  test('a room speaker is the principal of the call; the room is the session owner', () => {
    const record = toRecord(event({ sessionId: 'room:r9:g2' }), ctx, DEFAULTS)
    expect(record?.session).toMatchObject({ kind: 'room', roomId: 'r9', personId: null })
    expect(record?.call.speakerId).toBe('ana')
  })
})
