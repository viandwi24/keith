import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamingRepo, Sqlite } from '@keith/db'
import { dreamingRepo, migrateDatabase, openDatabase } from '@keith/db'
import { frontSessionId } from '../../platform/sessions.ts'
import {
  applyPlan,
  createDreamService,
  type JudgeCandidate,
  type JudgeResult,
  RECENT_TIER,
  readMemoryFile,
  TOO_SOON_MS,
} from '../hippocampus/index.ts'
import { createDreamSteps, DREAMING_RUN, FEW_MESSAGES_MIN } from './dream-steps.ts'
import type { StepRunInput } from './ports.ts'

// The `dreaming.run` step (P35.5.2): the cadence gate, the few-messages gate (no model call), the run service behind them, and the
// crash rule. A fake clock sets the times; the judge is a counted fake that keeps every candidate as a short-term fact.

const PERSON = 'ana'
const T0 = Date.UTC(2026, 10, 11, 3)
const HOUR = 60 * 60 * 1000

let dataDir: string
let sqlite: Sqlite
let repo: DreamingRepo
let clock: number
let judgeCalls: number
let messageSeq: number
let audits: { kind: string; detail?: Record<string, unknown> }[]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-steps-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = T0
  repo = dreamingRepo(sqlite, { now: () => clock })
  repo.setMode(PERSON, 'auto', PERSON)
  judgeCalls = 0
  messageSeq = 0
  audits = []
})

afterEach(() => {
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const keepJudge = async (
  _p: string,
  candidates: readonly JudgeCandidate[],
): Promise<JudgeResult> => {
  judgeCalls += 1
  return {
    ok: true,
    plan: {
      candidates: candidates.map((c) => ({
        id: c.id,
        action: 'keep-short-term' as const,
        target: 'recent',
        text: c.text,
        reason: 'said today',
        importance: 3,
        sourceMessageId: c.messageId,
      })),
    },
  }
}

function service(overrides: Partial<Parameters<typeof createDreamService>[0]> = {}) {
  return createDreamService({
    dataDir,
    sqlite,
    repo,
    generations: { current: () => 0 },
    owner: { isOwner: async () => false },
    settings: () => ({ maxUsdPerRun: 0.05, memberDefault: 'off' }),
    judge: keepJudge,
    audit: {
      record(event) {
        audits.push(event)
      },
    },
    now: () => clock,
    ...overrides,
  })
}

/** Plants user messages in the person's front session (the table eharness writes). */
function plant(texts: string[]): void {
  const stmt = sqlite.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const text of texts) {
    messageSeq += 1
    stmt.run(
      frontSessionId(PERSON, 0),
      `m${String(messageSeq).padStart(4, '0')}`,
      'user',
      JSON.stringify([{ type: 'text', text }]),
      JSON.stringify({ eharness: { v: 1, createdAt: clock } }),
      clock,
    )
  }
}

const FIVE = ['one', 'two', 'three', 'four', 'five'].map((w) => `I like ${w} things`)

/** The step input of the protocol's one step: only the fields the handler reads. */
function stepInput(): StepRunInput {
  return {
    run: { person: PERSON, protocolId: 'p1', id: 'run_x' },
    step: { id: 'dream-run', kind: 'system', action: DREAMING_RUN, next: 'end' },
  } as unknown as StepRunInput
}

const dreamStep = (svc: ReturnType<typeof service>) => createDreamSteps(svc)

describe('the cadence gate (too-soon)', () => {
  test('a run 20 hours after the previous start is allowed', async () => {
    const svc = service()
    plant(FIVE)
    expect(await dreamStep(svc)(stepInput())).toEqual({ kind: 'done', outcome: 'ok' })
    expect(judgeCalls).toBe(1)

    clock = T0 + TOO_SOON_MS
    plant(FIVE)
    expect(await dreamStep(svc)(stepInput())).toEqual({ kind: 'done', outcome: 'ok' })
    expect(judgeCalls).toBe(2)
  })

  test('a run 19 hours after the previous start is too-soon: no model call, no run row, one audit row', async () => {
    const svc = service()
    plant(FIVE)
    await dreamStep(svc)(stepInput())
    const rowsBefore = repo.listRuns(PERSON).length

    clock = T0 + 19 * HOUR
    plant(FIVE)
    expect(await dreamStep(svc)(stepInput())).toEqual({
      kind: 'done',
      outcome: 'refused:too-soon',
    })
    expect(judgeCalls).toBe(1)
    expect(repo.listRuns(PERSON).length).toBe(rowsBefore)
    expect(audits.at(-1)).toMatchObject({
      kind: 'dream.run',
      detail: { status: 'refused', reason: 'too-soon' },
    })
  })

  test('a refused too-soon does not move the cadence anchor: the next allowed run is still 20 hours after the start', async () => {
    const svc = service()
    plant(FIVE)
    await dreamStep(svc)(stepInput())
    clock = T0 + 19 * HOUR
    plant(FIVE)
    await dreamStep(svc)(stepInput())
    clock = T0 + 20 * HOUR
    expect(svc.isTooSoon(PERSON)).toBe(false)
  })
})

describe('the few-messages gate', () => {
  test('four new user messages are few-messages: no model call, a skipped row that holds the reason', async () => {
    const svc = service()
    plant(FIVE.slice(0, FEW_MESSAGES_MIN - 1))
    expect(svc.pendingUserMessages(PERSON)).toBe(FEW_MESSAGES_MIN - 1)
    expect(await dreamStep(svc)(stepInput())).toEqual({
      kind: 'done',
      outcome: 'refused:few-messages',
    })
    expect(judgeCalls).toBe(0)
    const row = repo.listRuns(PERSON)[0]
    expect(row?.status).toBe('skipped')
    expect(row?.reason).toBe('few-messages')
    expect(repo.latestStarted(PERSON)).toBeUndefined()
  })

  test('five new user messages pass the gate and call the model once', async () => {
    const svc = service()
    plant(FIVE)
    expect(svc.pendingUserMessages(PERSON)).toBe(FEW_MESSAGES_MIN)
    expect(await dreamStep(svc)(stepInput())).toEqual({ kind: 'done', outcome: 'ok' })
    expect(judgeCalls).toBe(1)
  })
})

describe('the crash rule', () => {
  test('a crash between judge and apply leaves the cursor and the files unchanged; the next run collects the same messages', async () => {
    const crashing = service({
      applier: () => {
        throw new Error('disk gone')
      },
      warn: () => {},
    })
    plant(FIVE)
    expect(await dreamStep(crashing)(stepInput())).toEqual({
      kind: 'done',
      outcome: 'failed:run',
    })
    expect(judgeCalls).toBe(1)
    expect(repo.cursorOf(PERSON)).toBeUndefined()
    expect(readMemoryFile(dataDir, PERSON, RECENT_TIER)).toBeUndefined()

    // the failed row still anchors the 20-hour window, so the healthy run starts once it has passed; the cursor never moved, so it collects the same five
    clock = T0 + TOO_SOON_MS
    const seen: string[] = []
    const healthy = service({
      judge: async (p, candidates) => {
        seen.push(...candidates.map((c) => c.text))
        return keepJudge(p, candidates)
      },
      applier: applyPlan,
    })
    expect(await dreamStep(healthy)(stepInput())).toEqual({ kind: 'done', outcome: 'ok' })
    expect(seen).toEqual(FIVE)
    expect(readMemoryFile(dataDir, PERSON, RECENT_TIER)).toContain('I like one things')
  })
})

describe('the step handler', () => {
  test('a system step of another action is refused as not dreaming', async () => {
    const other = {
      run: { person: PERSON, protocolId: 'p1', id: 'run_x' },
      step: { id: 'grace', kind: 'system', action: 'succession.cancel', next: 'end' },
    } as unknown as StepRunInput
    expect(await dreamStep(service())(other)).toEqual({
      kind: 'done',
      outcome: 'failed:not-dreaming',
    })
    expect(judgeCalls).toBe(0)
  })
})

describe('the budget of a run (P35.5.4)', () => {
  test('a run over its cap is refused:budget and the step says so; the person is told once, the cursor stays', async () => {
    const sent: string[] = []
    const svc = service({
      judge: async () => {
        judgeCalls += 1
        return { ok: false, reason: 'budget', cause: 'budget-cap' }
      },
      deliver: async (request) => {
        sent.push(request.id)
        return { status: 'delivered' }
      },
    })
    plant(FIVE)
    expect(await dreamStep(svc)(stepInput())).toEqual({
      kind: 'done',
      outcome: 'refused:budget',
    })
    expect(judgeCalls).toBe(1)
    expect(sent).toHaveLength(1)
    expect(repo.cursorOf(PERSON)).toBeUndefined()
  })
})
