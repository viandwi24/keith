import { describe, expect, test } from 'bun:test'
import { AUDIT_SUBJECT_FIELDS } from './audit.ts'
import { keithContract } from './contract.ts'
import {
  DREAM_ACTIONS,
  DREAM_MODE,
  DREAM_MODES,
  DREAM_REFUSAL_REASONS,
  DREAM_RUN,
  DREAM_RUN_STATUSES,
  DREAM_SETTING_KEYS,
  DREAMING_SETTINGS_DEFAULTS,
  DreamApplyInputSchema,
  DreamCandidateSchema,
  DreamDiaryInputSchema,
  DreamingSettingsSchema,
  DreamingSettingsSetSchema,
  DreamModeInputSchema,
  DreamModeSchema,
  DreamPlanSchema,
  DreamRefusalDataSchema,
  DreamRefusalReasonSchema,
  DreamRunAuditDetailSchema,
  DreamRunViewSchema,
  DreamTargetSchema,
  DreamUndoInputSchema,
} from './dreaming.ts'

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  action: 'promote',
  target: 'profile',
  text: 'Ana prefers short answers',
  reason: 'said it twice',
  importance: 6,
  sourceMessageId: 'm42',
  ...overrides,
})

describe('dream plan (the judge output)', () => {
  test('a valid plan parses; an extra plan field is refused', () => {
    expect(DreamPlanSchema.safeParse({ candidates: [candidate()] }).success).toBe(true)
    expect(DreamPlanSchema.safeParse({ candidates: [], note: 'extra' }).success).toBe(false)
  })

  test('an extra candidate field is refused too (strict)', () => {
    expect(DreamCandidateSchema.safeParse(candidate({ path: 'x.md' })).success).toBe(false)
  })

  test('the action set is the five actions and nothing else', () => {
    expect(DREAM_ACTIONS).toEqual(['keep-short-term', 'promote', 'merge', 'supersede', 'drop'])
    for (const action of DREAM_ACTIONS) {
      expect(DreamCandidateSchema.safeParse(candidate({ action })).success).toBe(true)
    }
    expect(DreamCandidateSchema.safeParse(candidate({ action: 'delete' })).success).toBe(false)
    expect(DreamCandidateSchema.safeParse(candidate({ action: 'rewrite' })).success).toBe(false)
  })

  test('a target is `profile`, `recent` or a topic file; a path separator is refused', () => {
    expect(DreamTargetSchema.safeParse('profile').success).toBe(true)
    expect(DreamTargetSchema.safeParse('recent').success).toBe(true)
    expect(DreamTargetSchema.safeParse('work-notes.md').success).toBe(true)
    expect(DreamTargetSchema.safeParse('../secrets.md').success).toBe(false)
    expect(DreamTargetSchema.safeParse('dreams/2026-11-11.md').success).toBe(false)
    expect(DreamTargetSchema.safeParse('undo\\x.md').success).toBe(false)
    expect(DreamTargetSchema.safeParse('Work.md').success).toBe(false)
    expect(DreamTargetSchema.safeParse('notes.txt').success).toBe(false)
    expect(DreamTargetSchema.safeParse(`${'a'.repeat(40)}.md`).success).toBe(true)
    expect(DreamTargetSchema.safeParse(`${'a'.repeat(41)}.md`).success).toBe(false)
  })

  test('importance is an integer from 1 to 10', () => {
    expect(DreamCandidateSchema.safeParse(candidate({ importance: 1 })).success).toBe(true)
    expect(DreamCandidateSchema.safeParse(candidate({ importance: 10 })).success).toBe(true)
    expect(DreamCandidateSchema.safeParse(candidate({ importance: 0 })).success).toBe(false)
    expect(DreamCandidateSchema.safeParse(candidate({ importance: 11 })).success).toBe(false)
    expect(DreamCandidateSchema.safeParse(candidate({ importance: 5.5 })).success).toBe(false)
  })

  test('text is at most 300 characters, reason at most 200, supersedes at most 300', () => {
    expect(DreamCandidateSchema.safeParse(candidate({ text: 'a'.repeat(300) })).success).toBe(true)
    expect(DreamCandidateSchema.safeParse(candidate({ text: 'a'.repeat(301) })).success).toBe(false)
    expect(DreamCandidateSchema.safeParse(candidate({ text: '' })).success).toBe(false)
    expect(DreamCandidateSchema.safeParse(candidate({ text: '', action: 'merge' })).success).toBe(
      false,
    )
    expect(DreamCandidateSchema.safeParse(candidate({ reason: 'a'.repeat(201) })).success).toBe(
      false,
    )
    expect(DreamCandidateSchema.safeParse(candidate({ supersedes: 'a'.repeat(301) })).success).toBe(
      false,
    )
    expect(
      DreamCandidateSchema.safeParse(candidate({ action: 'supersede', supersedes: 'old' })).success,
    ).toBe(true)
  })

  test('a drop needs no text: an empty text is valid for drop only', () => {
    for (const action of ['keep-short-term', 'promote', 'merge', 'supersede'] as const) {
      expect(DreamCandidateSchema.safeParse(candidate({ action, text: '' })).success).toBe(false)
    }
    expect(DreamCandidateSchema.safeParse(candidate({ action: 'drop', text: '' })).success).toBe(
      true,
    )
    expect(
      DreamPlanSchema.safeParse({ candidates: [candidate({ action: 'drop', text: '' })] }).success,
    ).toBe(true)
    // a drop may still carry text, within the cap; the strict fields stay refused
    expect(DreamCandidateSchema.safeParse(candidate({ action: 'drop' })).success).toBe(true)
    expect(
      DreamCandidateSchema.safeParse(candidate({ action: 'drop', text: '', path: 'x.md' })).success,
    ).toBe(false)
    expect(
      DreamCandidateSchema.safeParse(candidate({ action: 'drop', text: 'a'.repeat(301) })).success,
    ).toBe(false)
  })

  test('a plan holds at most 200 candidates', () => {
    const many = Array.from({ length: 201 }, () => candidate())
    expect(DreamPlanSchema.safeParse({ candidates: many }).success).toBe(false)
  })
})

describe('modes, refusals and views', () => {
  test('modes are off, propose and auto', () => {
    expect(DREAM_MODES).toEqual(['off', 'propose', 'auto'])
    expect(DreamModeSchema.safeParse('auto').success).toBe(true)
    expect(DreamModeSchema.safeParse('on').success).toBe(false)
    expect(DreamModeInputSchema.safeParse({ mode: 'propose' }).success).toBe(true)
    expect(DreamModeInputSchema.safeParse({ mode: 'propose', runId: 'r1' }).success).toBe(false)
  })

  test('the refusal reasons are the eight of ADR-0031', () => {
    const expected = [
      'too-soon',
      'few-messages',
      'no-model',
      'budget',
      'turn-running',
      'staged-changed',
      'nothing-to-undo',
      'off',
    ] as const
    expect([...DREAM_REFUSAL_REASONS].sort()).toEqual([...expected].sort())
    expect(DreamRefusalReasonSchema.safeParse('budget').success).toBe(true)
    expect(DreamRefusalReasonSchema.safeParse('busy').success).toBe(false)
    expect(DreamRefusalDataSchema.safeParse({ reason: 'too-soon' }).success).toBe(true)
  })

  test('a run row status is the table status set', () => {
    const table: string[] = [
      'running',
      'applied',
      'staged',
      'skipped',
      'refused',
      'failed',
      'rejected',
    ]
    expect([...DREAM_RUN_STATUSES].sort().join(',')).toBe([...table].sort().join(','))
  })

  test('a run view carries counts and state, and a judge failure is a reason', () => {
    const run = {
      id: 'r1',
      trigger: 'manual',
      mode: 'propose',
      status: 'failed',
      reason: 'judge',
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_500,
      counts: { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 },
      applied: false,
      staged: false,
    }
    expect(DreamRunViewSchema.safeParse(run).success).toBe(true)
    expect(DreamRunViewSchema.safeParse({ ...run, status: 'running' }).success).toBe(true)
    expect(DreamRunViewSchema.safeParse({ ...run, status: 'done' }).success).toBe(false)
    expect(DreamRunViewSchema.safeParse({ ...run, reason: 'busy' }).success).toBe(false)
  })
})

describe('RPC inputs', () => {
  test('apply needs a run id; undo takes an optional one; diary takes an optional date', () => {
    expect(DreamApplyInputSchema.safeParse({}).success).toBe(false)
    expect(DreamApplyInputSchema.safeParse({ runId: 'r1' }).success).toBe(true)
    expect(DreamUndoInputSchema.safeParse({}).success).toBe(true)
    expect(DreamUndoInputSchema.safeParse({ runId: 'r1' }).success).toBe(true)
    expect(DreamDiaryInputSchema.safeParse({}).success).toBe(true)
    expect(DreamDiaryInputSchema.safeParse({ date: '2026-11-11' }).success).toBe(true)
    expect(DreamDiaryInputSchema.safeParse({ date: '11/11/2026' }).success).toBe(false)
    expect(DreamDiaryInputSchema.safeParse({ personId: 'ana' }).success).toBe(true)
    expect(DreamDiaryInputSchema.safeParse({ personId: '' }).success).toBe(false)
  })

  test('the contract declares the dream area: chat procedures and the owner settings', () => {
    expect(Object.keys(keithContract.dream).sort()).toEqual(
      ['apply', 'diary', 'mode', 'now', 'settings', 'status', 'undo'].sort(),
    )
    expect(Object.keys(keithContract.dream.settings).sort()).toEqual(['get', 'set'])
  })
})

describe('settings', () => {
  test('the defaults are 0.15 USD and off for members', () => {
    expect(DREAMING_SETTINGS_DEFAULTS).toEqual({ maxUsdPerRun: 0.15, memberDefault: 'off' })
    expect(DREAM_SETTING_KEYS.maxUsdPerRun).toBe('dreaming.maxUsdPerRun')
    expect(DREAM_SETTING_KEYS.memberDefault).toBe('dreaming.memberDefault')
    expect(DreamingSettingsSchema.safeParse(DREAMING_SETTINGS_DEFAULTS).success).toBe(true)
  })

  test('maxUsdPerRun is between 0.01 and 0.50; 0.6 is refused', () => {
    expect(DreamingSettingsSetSchema.safeParse({ maxUsdPerRun: 0.01 }).success).toBe(true)
    expect(DreamingSettingsSetSchema.safeParse({ maxUsdPerRun: 0.5 }).success).toBe(true)
    expect(DreamingSettingsSetSchema.safeParse({ maxUsdPerRun: 0.6 }).success).toBe(false)
    expect(DreamingSettingsSetSchema.safeParse({ maxUsdPerRun: 0.005 }).success).toBe(false)
  })

  test('memberDefault is off or propose; auto is refused as a default', () => {
    expect(DreamingSettingsSetSchema.safeParse({ memberDefault: 'propose' }).success).toBe(true)
    expect(DreamingSettingsSetSchema.safeParse({ memberDefault: 'auto' }).success).toBe(false)
    expect(DreamingSettingsSetSchema.safeParse({}).success).toBe(false)
  })
})

describe('audit', () => {
  test('the four kinds name the subject person', () => {
    expect(DREAM_RUN).toBe('dream.run')
    expect(DREAM_MODE).toBe('dream.mode')
    for (const kind of ['dream.run', 'dream.apply', 'dream.undo', 'dream.mode']) {
      expect(AUDIT_SUBJECT_FIELDS[kind]).toEqual(['subject'])
    }
  })

  test('a refused run carries a reason and no counts; a counted run carries counts', () => {
    const refused = {
      subject: 'ana',
      mode: 'auto',
      trigger: 'schedule',
      status: 'refused',
      reason: 'too-soon',
    }
    expect(DreamRunAuditDetailSchema.safeParse(refused).success).toBe(true)
    const counted = {
      ...refused,
      status: 'applied',
      reason: null,
      candidates: 4,
      promoted: 1,
      merged: 0,
      superseded: 0,
      dropped: 3,
      applied: true,
    }
    expect(DreamRunAuditDetailSchema.safeParse(counted).success).toBe(true)
    expect(DreamRunAuditDetailSchema.safeParse({ ...refused, status: 'paused' }).success).toBe(
      false,
    )
  })
})
