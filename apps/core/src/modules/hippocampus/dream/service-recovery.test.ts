// The recovery paths of the dreaming service (docs/specs/dreaming.md "Undo and staged plans", "Service"): an undo that keeps a file
// changed after the run wrote it, a write that stops midway (`apply-partial`), a staged plan dropped at apply (`staged-changed`), and
// the expiry of a waiting plan. service.test.ts holds the rest of the service; this file keeps the same harness: a judge that keeps
// every candidate as a short-term fact, so the files show what the applier did.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DreamingRepo,
  dreamingRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import { frontSessionId } from '../../../platform/sessions.ts'
import type { Audit } from '../../audit/index.ts'
import { ApplyPartialError, applyPlan } from './apply.ts'
import { RECENT_TIER, readMemoryFile, stagedFileOf, writeMemoryFile } from './files.ts'
import type { JudgeResult } from './judge.ts'
import type { JudgeCandidate } from './prompt.ts'
import { createDreamService, DreamRefused, type DreamService, TOO_SOON_MS } from './service.ts'
import { openRunWriter } from './undo.ts'

const PERSON = 'ana'
const T0 = Date.UTC(2026, 10, 11, 3)

let dataDir: string
let sqlite: Sqlite
let repo: DreamingRepo
let clock: number
let audits: { kind: string; actor: string; via: string; detail?: Record<string, unknown> }[]
let events: { sessionId: string | null; type: string; payload: Record<string, unknown> }[]
let messageSeq: number

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-recovery-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = T0
  repo = dreamingRepo(sqlite, { now: () => clock })
  audits = []
  events = []
  messageSeq = 0
})

afterEach(() => {
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const audit: Audit = {
  record(event) {
    audits.push(event)
  },
}

/** A judge that keeps every candidate as a short-term fact of recent.md with the candidate's own source pointer. */
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

function service(overrides: Partial<Parameters<typeof createDreamService>[0]> = {}): DreamService {
  return createDreamService({
    dataDir,
    sqlite,
    repo,
    generations: { current: () => 0 },
    owner: { isOwner: async () => false },
    settings: () => ({ maxUsdPerRun: 0.05, memberDefault: 'off' }),
    judge: keepJudge,
    audit,
    activity: {
      record(sessionId, type, payload) {
        events.push({ sessionId, type, payload })
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

const recent = () => readMemoryFile(dataDir, PERSON, RECENT_TIER)

describe('a stopped core leaves running rows that the boot ends (P35.6.1)', () => {
  test('every running row ends failed with reason interrupted, fresh or not, and each gets its end brain event', () => {
    const old = repo.startRun({ personId: PERSON, trigger: 'schedule', mode: 'propose' })
    clock += 5 * 60 * 1000
    const fresh = repo.startRun({ personId: PERSON, trigger: 'manual', mode: 'propose' })
    const done = repo.startRun({ personId: PERSON, trigger: 'schedule', mode: 'propose' })
    repo.endRun(done, { status: 'staged' })
    events.length = 0
    expect(service().endInterrupted()).toBe(2)
    const byId = new Map(repo.listRuns(PERSON).map((r) => [r.id, r]))
    expect(byId.get(old)).toMatchObject({ status: 'failed', reason: 'interrupted' })
    expect(byId.get(fresh)).toMatchObject({ status: 'failed', reason: 'interrupted' })
    expect(byId.get(done)?.status).toBe('staged')
    const ends = events.filter((e) => e.type === 'brain.hippocampus.dream')
    expect(ends.map((e) => [e.payload.runId, e.payload.phase]).sort()).toEqual(
      [
        [old, 'end'],
        [fresh, 'end'],
      ].sort(),
    )
    expect(service().endInterrupted()).toBe(0)
  })

  test('each ended run writes one dream.run audit row: failed, interrupted, no counts', () => {
    repo.startRun({ personId: PERSON, trigger: 'schedule', mode: 'auto' })
    repo.startRun({ personId: PERSON, trigger: 'manual', mode: 'propose' })
    audits.length = 0
    expect(service().endInterrupted()).toBe(2)
    const rows = audits.filter((a) => a.kind === 'dream.run')
    expect(rows).toHaveLength(2)
    expect(rows.every((a) => a.actor === 'system')).toBe(true)
    expect(rows.map((a) => a.detail)).toContainEqual({
      subject: PERSON,
      mode: 'propose',
      trigger: 'manual',
      status: 'failed',
      reason: 'interrupted',
    })
    expect(rows.map((a) => a.detail)).toContainEqual({
      subject: PERSON,
      mode: 'auto',
      trigger: 'schedule',
      status: 'failed',
      reason: 'interrupted',
    })
  })
})

describe('undo after a chat write (FR3-12)', () => {
  test('a file the person wrote after the auto run is kept on undo and named in skipped', async () => {
    repo.setMode(PERSON, 'auto', PERSON)
    plant(['I like short answers'])
    const runId = (await service().run(PERSON, 'manual')).runId ?? ''
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, '- Typed after the dream\n')
    const undone = service().undo(PERSON, runId)
    expect(undone).toEqual({ runId, restored: 0, skipped: ['recent.md'] })
    expect(recent()).toBe('- Typed after the dream\n')
    expect(await service().status(PERSON)).toMatchObject({ canUndo: false })
  })
})

describe('a write that stops midway (FR3-13)', () => {
  /** An applier that writes recent.md and then fails as a second write would: the first file is changed, the run is partial. */
  const stopsAfterFirstWrite = (runId: string): never => {
    openRunWriter(dataDir, PERSON, runId).write(RECENT_TIER, '- partial\n')
    throw new ApplyPartialError(1, new Error('disk full'))
  }

  test('an auto run that stops while writing ends failed with apply-partial, keeps the undo window, and undo puts the file back', async () => {
    repo.setMode(PERSON, 'auto', PERSON)
    plant(['I like short answers'])
    const svc = service({ applier: (input) => stopsAfterFirstWrite(input.runId) })
    const result = await svc.run(PERSON, 'schedule')
    expect(result).toMatchObject({ status: 'failed', reason: 'apply-partial', applied: false })
    const row = repo.listRuns(PERSON)[0]
    expect(row).toMatchObject({ status: 'failed', reason: 'apply-partial' })
    expect(row?.undoUntil).toBe(T0 + 7 * 24 * 60 * 60 * 1000)
    expect(recent()).toBe('- partial\n')
    expect(await svc.status(PERSON)).toMatchObject({ canUndo: true })
    const rowId = row?.id ?? ''
    expect(svc.undo(PERSON)).toEqual({ runId: rowId, restored: 0, skipped: [] })
    expect(recent()).toBeUndefined()
  })

  test('a manual apply that stops while writing ends the run failed, spends the staged plan, and keeps the undo window', async () => {
    repo.setMode(PERSON, 'propose', PERSON)
    plant(['I like short answers'])
    const run = await service().run(PERSON, 'schedule')
    const svc = service({
      applier: (input) =>
        input.dryRun === true ? applyPlan(input) : stopsAfterFirstWrite(input.runId),
    })
    const runId = run.runId ?? ''
    const applied = await svc.apply(PERSON, runId)
    expect(applied).toEqual({ runId, applied: 0, staged: 0 })
    expect(repo.listRuns(PERSON)[0]).toMatchObject({ status: 'failed', reason: 'apply-partial' })
    expect(existsSync(stagedFileOf(dataDir, PERSON, run.runId ?? ''))).toBe(false)
    expect(audits.filter((a) => a.kind === 'dream.apply')).toHaveLength(0)
    expect(await svc.status(PERSON)).toMatchObject({ canApply: false, canUndo: true })
    svc.undo(PERSON)
    expect(recent()).toBeUndefined()
  })
})

describe('a dropped plan is planned again (FR3-11)', () => {
  test('the run after a dropped plan collects the same messages again and plans them', async () => {
    repo.setMode(PERSON, 'propose', PERSON)
    plant(['I like short answers'])
    const first = await service().run(PERSON, 'schedule')
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, '- Typed by the person\n')
    await expect(service().apply(PERSON, first.runId ?? '')).rejects.toBeInstanceOf(DreamRefused)
    // too-soon is unchanged: the next run starts once the 20-hour window has passed
    clock += TOO_SOON_MS
    const seen: string[] = []
    const second = await service({
      judge: async (personId, candidates) => {
        seen.push(...candidates.map((c) => c.text))
        return keepJudge(personId, candidates)
      },
    }).run(PERSON, 'schedule')
    expect(second.status).toBe('staged')
    expect(seen).toEqual(['I like short answers'])
  })
})

describe('the expiry of a waiting plan (FR3-18)', () => {
  test('a waiting plan shows when it expires (7 days after its run ended); nothing once it is applied', async () => {
    repo.setMode(PERSON, 'propose', PERSON)
    plant(['I like short answers'])
    const svc = service()
    const run = await svc.run(PERSON, 'schedule')
    expect((await svc.status(PERSON)).stagedExpiresAt).toBe(T0 + 7 * 24 * 60 * 60 * 1000)
    await svc.apply(PERSON, run.runId ?? '')
    expect((await svc.status(PERSON)).stagedExpiresAt).toBeUndefined()
  })
})
