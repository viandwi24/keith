import { describe, expect, test } from 'bun:test'
import type { DreamRunView } from '@keith/contracts'
import {
  changesOf,
  type DreamRunning,
  dreamDividerOf,
  dreamEndFallbackOf,
  dreamingLineOf,
  dreamRefusedDividerOf,
  reduceDreamRunning,
} from './dream-pending.ts'
import { dateOf, stagedExpiresAtOf } from './dream-state.ts'

const COUNTS = { candidates: 3, promoted: 1, merged: 1, superseded: 0, dropped: 1 }
const view = (over: Partial<Pick<DreamRunView, 'status' | 'reason' | 'counts'>>) => ({
  status: 'staged' as const,
  reason: null,
  counts: COUNTS,
  ...over,
})

describe('reduceDreamRunning', () => {
  test('a start runs, its end stops it; an end of another run leaves it', () => {
    const started = reduceDreamRunning(undefined, { type: 'start', runId: 'r1', at: 100 })
    expect(started).toEqual({ runId: 'r1', startedAt: 100 })
    expect(reduceDreamRunning(started, { type: 'end', runId: 'other' })).toBe(started)
    expect(reduceDreamRunning(started, { type: 'end', runId: 'r1' })).toBeUndefined()
  })

  test('a resync forgets the run: its end may have been missed', () => {
    const started = reduceDreamRunning(undefined, { type: 'start', runId: 'r1', at: 1 })
    expect(reduceDreamRunning(started, { type: 'resync' })).toBeUndefined()
  })

  test('a start carries a candidate count only when it is above zero', () => {
    expect(
      reduceDreamRunning(undefined, { type: 'start', runId: 'r', at: 1, candidates: 0 }),
    ).toEqual({
      runId: 'r',
      startedAt: 1,
    })
    expect(
      reduceDreamRunning(undefined, { type: 'start', runId: 'r', at: 1, candidates: 4 }),
    ).toEqual({ runId: 'r', startedAt: 1, candidates: 4 })
  })
})

describe('dreamingLineOf', () => {
  const running: DreamRunning = { runId: 'r', startedAt: 10_000 }

  test('the seconds count up; no count is shown while the start carries none', () => {
    expect(dreamingLineOf(running, 10_000)).toBe('dreaming · 0 s')
    expect(dreamingLineOf(running, 22_900)).toBe('dreaming · 12 s')
  })

  test('a known count reads as reviewing N notes', () => {
    expect(dreamingLineOf({ ...running, candidates: 3 }, 12_000)).toBe(
      'dreaming · reviewing 3 notes · 2 s',
    )
    expect(dreamingLineOf({ ...running, candidates: 1 }, 12_000)).toBe(
      'dreaming · reviewing 1 note · 2 s',
    )
  })

  test('a clock behind the start never shows a negative time', () => {
    expect(dreamingLineOf(running, 5_000)).toBe('dreaming · 0 s')
  })
})

describe('dreamDividerOf', () => {
  test('staged: the changes wait for /dream apply; none means nothing to change', () => {
    expect(dreamDividerOf(view({}))).toBe(
      'dream finished · 3 reviewed · 2 changes waiting (/dream apply)',
    )
    expect(dreamDividerOf(view({ counts: { ...COUNTS, promoted: 0, merged: 0 } }))).toBe(
      'dream finished · 3 reviewed · nothing to change',
    )
  })

  test('applied (auto mode): the changes are saved, with the undo window', () => {
    expect(dreamDividerOf(view({ status: 'applied' }))).toBe(
      'dream finished · 3 reviewed · 2 changes saved (/dream undo within 7 days)',
    )
    expect(
      dreamDividerOf(view({ status: 'applied', counts: { ...COUNTS, promoted: 0, merged: 0 } })),
    ).toBe('dream finished · 3 reviewed · nothing to change')
  })

  test('failed: the plain reason sentence', () => {
    expect(dreamDividerOf(view({ status: 'failed', reason: 'judge' }))).toBe(
      "dream failed · the model's plan was not valid",
    )
    expect(dreamDividerOf(view({ status: 'failed', reason: 'turn-error' }))).toBe(
      'dream failed · the model turn failed',
    )
    expect(dreamDividerOf(view({ status: 'failed', reason: 'interrupted' }))).toBe(
      'dream failed · the core stopped during the run',
    )
    expect(dreamDividerOf(view({ status: 'failed', reason: null }))).toBe(
      'dream failed · an unexpected error stopped the run',
    )
  })

  test('refused and skipped runs name their cause, never a bare status', () => {
    expect(dreamDividerOf(view({ status: 'refused', reason: 'no-model' }))).toBe(
      'dream refused · no model for the cortex role',
    )
    expect(dreamDividerOf(view({ status: 'refused', reason: 'budget' }))).toBe(
      'dream refused · over the budget',
    )
    expect(dreamDividerOf(view({ status: 'refused', reason: null }))).toBe(
      'dream refused · the run did not start',
    )
    expect(dreamDividerOf(view({ status: 'skipped', reason: 'few-messages' }))).toBe(
      'dream skipped · not enough new messages',
    )
    expect(dreamDividerOf(view({ status: 'skipped', reason: null }))).toBe(
      'dream skipped · no new messages to review',
    )
  })

  test('skipped: the skip sentence; refused: the refusal sentence', () => {
    expect(dreamDividerOf(view({ status: 'skipped', reason: 'budget-low' }))).toBe(
      'Skipped: your budget is nearly used up.',
    )
    expect(dreamDividerOf(view({ status: 'refused', reason: 'too-soon' }))).toBe(
      'dream refused · too soon, the last run is less than 20 hours old',
    )
    expect(dreamRefusedDividerOf('off')).toBe(
      'dream refused · dreaming is off; turn it on with /dream mode propose',
    )
  })

  test('rejected: the plan was not accepted, nothing was written', () => {
    expect(dreamDividerOf(view({ status: 'rejected' }))).toBe(
      'dream rejected · the plan was not accepted; nothing was written.',
    )
  })

  test('changesOf counts promoted, merged and superseded, never dropped', () => {
    expect(changesOf({ ...COUNTS, dropped: 9 })).toBe(2)
  })

  test('an end whose run the status no longer shows reads from its own counts', () => {
    expect(
      dreamEndFallbackOf({
        candidates: 3,
        promoted: 1,
        merged: 0,
        superseded: 0,
        dropped: 0,
        applied: true,
      }),
    ).toBe('dream finished · 3 reviewed · 1 change saved (/dream undo within 7 days)')
    expect(
      dreamEndFallbackOf({
        candidates: 3,
        promoted: 1,
        merged: 0,
        superseded: 0,
        dropped: 0,
        applied: false,
      }),
    ).toBe('dream finished · 3 reviewed · 1 change waiting (/dream apply)')
  })

  test('an end that carries its status and reason names the cause, even when the status moved on', () => {
    const none = { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 }
    expect(
      dreamEndFallbackOf({
        ...none,
        applied: false,
        status: 'failed',
        reason: 'judge',
      }),
    ).toBe("dream failed · the model's plan was not valid")
    expect(
      dreamEndFallbackOf({
        ...none,
        applied: false,
        status: 'refused',
        reason: 'no-model',
      }),
    ).toBe('dream refused · no model for the cortex role')
    expect(
      dreamEndFallbackOf({
        ...none,
        applied: false,
        status: 'skipped',
        reason: 'budget-low',
      }),
    ).toBe('Skipped: your budget is nearly used up.')
  })
})

describe('the divider of a waiting plan names its expiry date (FR3-18)', () => {
  test('a staged run that ended names the date its plan expires; without an end time the divider is as before', () => {
    const finished = Date.UTC(2026, 10, 11, 12)
    expect(dreamDividerOf({ ...view({}), finishedAt: finished })).toBe(
      `dream finished · 3 reviewed · 2 changes waiting (/dream apply) · expires ${dateOf(stagedExpiresAtOf(finished))}`,
    )
    expect(dreamDividerOf(view({}))).toBe(
      'dream finished · 3 reviewed · 2 changes waiting (/dream apply)',
    )
  })
})
