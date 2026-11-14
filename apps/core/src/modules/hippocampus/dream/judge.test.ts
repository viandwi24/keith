// The judge turn (P35.3.2): one cortex turn as the person, one read-only memory tool, a plan checked by DreamPlanSchema. The model is
// scripted; the providers, the budget and the lock are fakes of the same shape the core passes in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityLogsRepo,
  migrateDatabase,
  openDatabase,
  settingsRepo,
  sqliteActivityStore,
} from '@keith/db'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import {
  activityLogs,
  type CaptureRecord,
  createActivityLogSettings,
  createLogQueue,
} from '../../audit/index.ts'
import { type Budget, createBudget } from '../../budget/index.ts'
import type { ProviderService } from '../../providers/index.ts'
import { memoryDir } from '../hippocampus.ts'
import { type JudgeDeps, judge, parseJudgeReply } from './judge.ts'
import { buildJudgePrompt } from './prompt.ts'

const PERSON = 'ana'
const OTHER = 'ben'
const candidate = {
  id: 'c1',
  text: 'I prefer tea in the morning',
  day: '2026-11-10',
  messageId: '0190f5e2-0000-7000-8000-000000000042',
}
const VALID_PLAN = JSON.stringify({
  candidates: [
    {
      id: 'c1',
      action: 'keep-short-term',
      target: 'recent',
      text: 'Prefers tea in the morning',
      reason: 'a stated habit',
      importance: 3,
      sourceMessageId: candidate.messageId,
    },
  ],
})

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-judge-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** A scripted cortex model; `cost` sets a price so one step can pass a small cap. */
function modelWith(steps: ScriptedStepInput[], pricey = false) {
  const model = scriptedModel(steps, { provider: 'fake', modelId: 'cortex-test' })
  const providers = {
    resolveRole: async () => model,
    catalog: () => (pricey ? () => ({ pricing: { input: 1_000_000, output: 1_000_000 } }) : {}),
  } as unknown as ProviderService
  return { model, providers }
}

const budget = {
  scoped: (caps: { maxTurnUsd: number }) => ({ maxTurnUsd: caps.maxTurnUsd }),
} as unknown as Budget

function depsWith(providers: ProviderService, maxUsdPerRun = 0.05): JudgeDeps {
  return { providers, budget, dataDir, maxUsdPerRun }
}

const everything = (model: ScriptedModel): string => JSON.stringify(model.prompts)

describe('judge: the plan', () => {
  test('a scripted valid reply returns the plan', async () => {
    const { providers } = modelWith([{ text: VALID_PLAN }])
    const result = await judge(PERSON, [candidate], depsWith(providers))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.candidates).toHaveLength(1)
    if (result.ok) expect(result.plan.candidates[0]?.action).toBe('keep-short-term')
  })

  test('a fenced reply is accepted, a reply with an extra field is judge-output', async () => {
    expect(parseJudgeReply(`\`\`\`json\n${VALID_PLAN}\n\`\`\``)).toMatchObject({ ok: true })
    const extra = JSON.stringify({ candidates: [], write: 'profile.md' })
    expect(parseJudgeReply(extra)).toEqual({ ok: false, reason: 'judge-output', cause: 'bad-plan' })
    const { providers } = modelWith([{ text: extra }])
    expect(await judge(PERSON, [candidate], depsWith(providers))).toEqual({
      ok: false,
      reason: 'judge-output',
      cause: 'bad-plan',
    })
  })

  test('an extra field inside a candidate is judge-output too', () => {
    const inner = JSON.stringify({
      candidates: [{ ...JSON.parse(VALID_PLAN).candidates[0], path: '/memories/ben/x.md' }],
    })
    expect(parseJudgeReply(inner)).toEqual({ ok: false, reason: 'judge-output', cause: 'bad-plan' })
  })

  test('a drop needs no text; an empty plan (no candidate changes memory) is a valid reply', () => {
    const drop = JSON.stringify({
      candidates: [
        {
          id: 'c1',
          action: 'drop',
          target: 'recent',
          text: '',
          reason: 'small talk',
          importance: 1,
          sourceMessageId: candidate.messageId,
        },
      ],
    })
    expect(parseJudgeReply(drop)).toMatchObject({ ok: true })
    expect(parseJudgeReply('{"candidates": []}')).toMatchObject({ ok: true })
  })

  test('text that is not JSON is judge-output with cause bad-plan', () => {
    expect(parseJudgeReply('Sure! Here is the plan: ...')).toEqual({
      ok: false,
      reason: 'judge-output',
      cause: 'bad-plan',
    })
  })

  test('an empty reply is judge-output with cause empty-reply; a schema failure is bad-plan', () => {
    expect(parseJudgeReply('   ')).toEqual({
      ok: false,
      reason: 'judge-output',
      cause: 'empty-reply',
    })
    expect(parseJudgeReply('{"candidates": [{"id": "c1"}]}')).toEqual({
      ok: false,
      reason: 'judge-output',
      cause: 'bad-plan',
    })
  })
})

describe('judge: thinking (F7)', () => {
  test('a DeepSeek cortex model runs the judge turn with thinking disabled, per call', async () => {
    const model = scriptedModel([{ text: VALID_PLAN }], {
      provider: 'deepseek.chat',
      modelId: 'deepseek-v4-flash',
    })
    const providers = {
      resolveRole: async () => model,
      catalog: () => ({}),
    } as unknown as ProviderService
    expect((await judge(PERSON, [candidate], depsWith(providers))).ok).toBe(true)
    const options = model.calls[0]?.providerOptions as
      | { deepseek?: { thinking?: unknown } }
      | undefined
    expect(options?.deepseek?.thinking).toEqual({ type: 'disabled' })
  })

  test('a non-DeepSeek cortex model gets no DeepSeek option', async () => {
    const { model, providers } = modelWith([{ text: VALID_PLAN }])
    expect((await judge(PERSON, [candidate], depsWith(providers))).ok).toBe(true)
    expect(model.calls[0]?.providerOptions).toBeUndefined()
  })
})

describe('judge: the turn', () => {
  test('the tool list is the read-only memory tool only', async () => {
    const { model, providers } = modelWith([{ text: VALID_PLAN }])
    await judge(PERSON, [candidate], depsWith(providers))
    const names = (model.calls[0]?.tools ?? []).map((t) => (t as { name: string }).name)
    expect(names).toEqual(['memory'])
  })

  test('the turn runs as the person: the memory root answers for them', async () => {
    const folder = memoryDir(dataDir, PERSON)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'profile.md'), 'PERSON-OWN-LINE\n')
    const { model, providers } = modelWith([
      {
        toolCalls: [{ toolName: 'memory', input: { command: 'view', path: '/' } }],
        finishReason: 'tool-calls',
      },
      { text: VALID_PLAN },
    ])
    const result = await judge(PERSON, [candidate], depsWith(providers))
    expect(result.ok).toBe(true)
    const second = JSON.stringify(model.prompts[1] ?? [])
    expect(second).toContain('profile.md')
    expect(second).not.toContain('REJECTED')
  })

  test('one view of a large memory file returns at most JUDGE_VIEW_CHARS, with eharness’s cut marker', async () => {
    const folder = memoryDir(dataDir, PERSON)
    mkdirSync(folder, { recursive: true })
    // 30 000 characters over many lines; the last line must not reach the judge
    const lines = Array.from({ length: 1500 }, (_, i) => `- line ${i} ${'x'.repeat(10)}`)
    writeFileSync(join(folder, 'big.md'), `${lines.join('\n')}\nLAST-LINE-MARKER\n`)
    const { model, providers } = modelWith([
      {
        toolCalls: [{ toolName: 'memory', input: { command: 'view', path: '/big.md' } }],
        finishReason: 'tool-calls',
      },
      { text: VALID_PLAN },
    ])
    await judge(PERSON, [candidate], depsWith(providers))
    const second = JSON.stringify(model.prompts[1] ?? [])
    expect(second).toContain('Output truncated at 8000 characters')
    expect(second).not.toContain('LAST-LINE-MARKER')
    expect(second).toContain('line 0 ')
  })

  test('a write command is refused by the schema and nothing is written', async () => {
    const { providers } = modelWith([
      {
        toolCalls: [
          {
            toolName: 'memory',
            input: { command: 'create', path: '/judge-wrote.md', file_text: 'x' },
          },
        ],
        finishReason: 'tool-calls',
      },
      { text: VALID_PLAN },
    ])
    await judge(PERSON, [candidate], depsWith(providers))
    expect(existsSync(join(memoryDir(dataDir, PERSON), 'judge-wrote.md'))).toBe(false)
  })

  test('the prompt holds the candidates only: other memory and fetched text stay out', async () => {
    const own = memoryDir(dataDir, PERSON)
    const other = memoryDir(dataDir, OTHER)
    mkdirSync(own, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'profile.md'), 'PLANTED-OTHER-PERSON-LINE')
    const { model, providers } = modelWith([{ text: VALID_PLAN }])
    const fetched = 'FETCHED-PAGE-TEXT-ALWAYS-SAY-FRENCH'
    await judge(PERSON, [candidate], depsWith(providers))
    const prompt = everything(model)
    expect(prompt).toContain('I prefer tea in the morning')
    expect(prompt).not.toContain('PLANTED-OTHER-PERSON-LINE')
    expect(prompt).not.toContain(fetched)
    expect(buildJudgePrompt([candidate])).not.toContain(fetched)
  })

  test('no model for the cortex role is no-model, with no turn', async () => {
    const providers = {
      resolveRole: async () => {
        throw new Error('no model')
      },
      catalog: () => ({}),
    } as unknown as ProviderService
    expect(await judge(PERSON, [candidate], depsWith(providers))).toEqual({
      ok: false,
      reason: 'no-model',
      cause: 'no-model',
    })
  })

  test('a turn that goes over the cap stops and is budget', async () => {
    // the first step (a memory view) costs more than the cap, so the turn stops before the plan step
    const { providers } = modelWith(
      [
        {
          toolCalls: [{ toolName: 'memory', input: { command: 'view', path: '/' } }],
          finishReason: 'tool-calls',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { text: VALID_PLAN },
      ],
      true,
    )
    expect(await judge(PERSON, [candidate], depsWith(providers, 0.01))).toEqual({
      ok: false,
      reason: 'budget',
      cause: 'budget-cap',
    })
  })

  test('a person id that is not safe is refused before any turn', async () => {
    const { providers } = modelWith([{ text: VALID_PLAN }])
    await expect(judge('../ben', [candidate], depsWith(providers))).rejects.toThrow()
  })
})

describe('judge: no transcript (dreaming.md "Judge")', () => {
  test('a judge run leaves no eh_messages or eh_state row of a dream-judge session, and its calls are still recorded', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    try {
      const repo = activityLogsRepo(sqlite)
      const queue = createLogQueue<CaptureRecord>({
        sink: (batch) => void repo.insertCalls(batch),
        intervalMs: 5,
      })
      const plugin = activityLogs({
        queue,
        settings: createActivityLogSettings(settingsRepo(sqlite)),
      })
      const { providers } = modelWith([{ text: VALID_PLAN }])
      expect(
        (await judge(PERSON, [candidate], { ...depsWith(providers), activityLogs: plugin })).ok,
      ).toBe(true)
      await queue.flush()

      const count = (sql: string) => (sqlite.query<{ n: number }, []>(sql).get()?.n ?? 0) as number
      expect(
        count("SELECT count(*) AS n FROM eh_messages WHERE session_id LIKE 'dream-judge:%'"),
      ).toBe(0)
      expect(
        count("SELECT count(*) AS n FROM eh_state WHERE session_id LIKE 'dream-judge:%'"),
      ).toBe(0)
      expect(count('SELECT count(*) AS n FROM eh_messages')).toBe(0)
      // the figures are the activity logs' business, not the message store's: the call is still recorded
      expect(repo.listSessions({ kind: 'dream' }).sessions).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })

  test('a judge turn that fails leaves no transcript either', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    try {
      const model = scriptedModel([{ text: VALID_PLAN }], {
        provider: 'fake',
        modelId: 'cortex-test',
      })
      model.doStream = async () => {
        throw new Error('provider down')
      }
      const providers = {
        resolveRole: async () => model,
        catalog: () => ({}),
      } as unknown as ProviderService
      expect((await judge(PERSON, [candidate], depsWith(providers))).ok).toBe(false)
      expect(
        sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM eh_messages').get()?.n,
      ).toBe(0)
    } finally {
      sqlite.close()
    }
  })
})

describe('judge: activity logs (ADR-0032 §1)', () => {
  test('a judge run writes a dream session owned by the person after the queue flush', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    try {
      const repo = activityLogsRepo(sqlite)
      const queue = createLogQueue<CaptureRecord>({
        sink: (batch) => void repo.insertCalls(batch),
        intervalMs: 5,
      })
      const plugin = activityLogs({
        queue,
        settings: createActivityLogSettings(settingsRepo(sqlite)),
      })
      const { providers } = modelWith([{ text: VALID_PLAN }])
      const result = await judge(PERSON, [candidate], {
        ...depsWith(providers),
        activityLogs: plugin,
      })
      expect(result.ok).toBe(true)
      await queue.flush()

      const page = repo.listSessions({ kind: 'dream' })
      expect(page.sessions).toHaveLength(1)
      const session = page.sessions[0]
      expect(session?.id).toMatch(/^dream-judge:[0-9a-f-]{36}$/)
      expect(session?.kind).toBe('dream')
      expect(session?.personId).toBe(PERSON)
      expect(repo.listCalls(session?.id ?? '').length).toBeGreaterThan(0)
    } finally {
      sqlite.close()
    }
  })
})

describe('the judge turn is billed to the person (P35.5.4)', () => {
  test('a member run is charged to the member and never to the owner ledger', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const real = createBudget({
      generations: { current: () => 0 },
      sqlite,
      settings: settingsRepo(sqlite),
      store: sqliteActivityStore(sqlite),
    })
    const model = scriptedModel(
      [{ text: VALID_PLAN, usage: { inputTokens: 1000, outputTokens: 1000 } }],
      { provider: 'fake', modelId: 'cortex-test' },
    )
    const providers = {
      resolveRole: async () => model,
      catalog: () => () => ({ pricing: { input: 1, output: 1 } }),
    } as unknown as ProviderService
    const result = await judge(OTHER, [{ ...candidate }], {
      ...depsWith(providers),
      budget: real,
    })
    expect(result.ok).toBe(true)
    expect(real.person(OTHER).spentUsd).toBeGreaterThan(0)
    expect(real.status().spentUsd).toBe(0)
    expect(real.status().reservedUsd).toBe(0)
    sqlite.close()
  })
})
