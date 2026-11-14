// The staged notice (P35.6.2): one message per staged run, counts and the command only, and a second run on the same day with an
// identical plan sends nothing more. The delivery is a fake with delivery's rule (a stored id sends nothing); the service run is real.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryRequestInput, DreamPlan, DreamRunCounts } from '@keith/contracts'
import { dreamingRepo, migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { frontSessionId } from '../../../platform/sessions.ts'
import type { Audit } from '../../audit/index.ts'
import type { JudgeResult } from './judge.ts'
import {
  planFingerprint,
  type StagedNotice,
  sendStagedNotice,
  stagedNoticeRequest,
  stagedNoticeText,
} from './notify.ts'
import type { JudgeCandidate } from './prompt.ts'
import { createDreamService } from './service.ts'

const PERSON = 'ana'
const PLANTED = 'PLANTED-ENTRY-TEXT-SHOULD-NOT-LEAK'
const T0 = Date.UTC(2026, 10, 11, 0, 30)
const HOUR = 60 * 60 * 1000

const COUNTS: DreamRunCounts = {
  candidates: 5,
  promoted: 1,
  merged: 1,
  superseded: 0,
  dropped: 2,
}

const plan = (text: string, action: 'keep-short-term' | 'drop' = 'keep-short-term'): DreamPlan => ({
  candidates: [
    {
      id: 'c1',
      action,
      target: 'recent',
      text,
      reason: 'said today',
      importance: 3,
      sourceMessageId: '0190f5e2-0000-7000-8000-000000000001',
    },
  ],
})

/** A store with delivery's rule: a request whose id is stored sends nothing. */
function store() {
  const rows = new Map<string, DeliveryRequestInput>()
  const warnings: string[] = []
  return {
    rows,
    warnings,
    deliver: async (request: DeliveryRequestInput) => {
      if (!rows.has(request.id)) rows.set(request.id, request)
      return { ok: true }
    },
    warn: (message: string) => warnings.push(message),
  }
}

const notice = (overrides: Partial<StagedNotice> = {}): StagedNotice => ({
  personId: PERSON,
  day: '2026-11-11',
  runId: 'run-1',
  plan: plan(PLANTED),
  counts: COUNTS,
  ...overrides,
})

describe('the text and the request', () => {
  test('the text carries the counts and the command, and no candidate or entry text', () => {
    const text = stagedNoticeText(COUNTS)
    expect(text).toContain('/dream apply')
    expect(text).toContain('5 new notes')
    expect(text).toContain('2 changes waiting')
    expect(text).not.toContain(PLANTED)
  })

  test('the request is a note of the person, from dreaming, carrying no entry text', () => {
    const request = stagedNoticeRequest(notice())
    expect(request).toMatchObject({
      source: 'dreaming',
      to: PERSON,
      name: 'dreaming.notice',
      needs: { mode: 'note' },
    })
    expect(request.id).toStartWith(`dream-staged:${PERSON}:2026-11-11:`)
    expect(request.text).not.toContain(PLANTED)
    expect(JSON.stringify(request)).not.toContain(PLANTED)
  })

  test('the fingerprint is the plan shape: the same actions on the same targets, whatever the text', () => {
    expect(planFingerprint(plan('one wording'))).toBe(planFingerprint(plan('another wording')))
    expect(planFingerprint(plan('one wording'))).not.toBe(
      planFingerprint(plan('one wording', 'drop')),
    )
    expect(planFingerprint({ candidates: [] })).toHaveLength(16)
  })
})

describe('one message per staged run', () => {
  test('one run sends one message; a second run the same day with the same shape sends none more', async () => {
    const s = store()
    await sendStagedNotice(s.deliver, notice({ runId: 'run-1' }), s.warn)
    await sendStagedNotice(s.deliver, notice({ runId: 'run-2', plan: plan('other text') }), s.warn)
    expect(s.rows.size).toBe(1)
  })

  test('a different shape the same day, or the same shape the next day, sends its own message', async () => {
    const s = store()
    await sendStagedNotice(s.deliver, notice(), s.warn)
    await sendStagedNotice(s.deliver, notice({ plan: plan(PLANTED, 'drop') }), s.warn)
    await sendStagedNotice(s.deliver, notice({ day: '2026-11-12' }), s.warn)
    expect(s.rows.size).toBe(3)
  })

  test('a failed delivery is warned and never thrown; no deliver means nothing is sent', async () => {
    const s = store()
    await sendStagedNotice(
      async () => {
        throw new Error('delivery is down')
      },
      notice(),
      s.warn,
    )
    expect(s.warnings).toEqual(['dreaming: staged notice not sent: delivery is down'])
    await sendStagedNotice(undefined, notice(), s.warn)
    expect(s.rows.size).toBe(0)
  })
})

describe('the service sends the notice of a propose run', () => {
  let dataDir: string
  let sqlite: Sqlite
  let clock: number
  let messageSeq: number
  const audit: Audit = { record() {} }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-notify-'))
    sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    clock = T0
    messageSeq = 0
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

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

  /** A judge that keeps every candidate as a short-term fact: the same shape on every run. */
  const keepJudge = async (
    _personId: string,
    candidates: readonly JudgeCandidate[],
  ): Promise<JudgeResult> => ({
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
  })

  test('two propose runs on the same day with the same shape store one message; each names /dream apply', async () => {
    const repo = dreamingRepo(sqlite, { now: () => clock })
    repo.setMode(PERSON, 'propose', PERSON)
    const s = store()
    const service = createDreamService({
      dataDir,
      sqlite,
      repo,
      generations: { current: () => 0 },
      owner: { isOwner: async () => false },
      settings: () => ({ maxUsdPerRun: 0.05, memberDefault: 'off' }),
      judge: keepJudge,
      audit,
      now: () => clock,
      deliver: s.deliver,
    })

    plant(['I like short answers', 'Flat key is in the blue box', 'Tea in the morning', 'x', 'y'])
    const first = await service.run(PERSON, 'schedule')
    expect(first.status).toBe('staged')

    // the same day, 21 hours later (past the 20-hour window), with five more messages of the same kind
    clock += 21 * HOUR
    plant(['one more', 'two more', 'three more', 'four more', 'five more'])
    const second = await service.run(PERSON, 'schedule')
    expect(second.status).toBe('staged')

    expect(s.rows.size).toBe(1)
    const [sent] = [...s.rows.values()]
    expect(sent?.text).toContain('/dream apply')
    expect(sent?.text).not.toContain('short answers')
    expect(JSON.stringify(sent)).not.toContain('blue box')
  })
})
