import { describe, expect, test } from 'bun:test'
import { DREAM_SKIP_REASONS, type DreamRunView } from '@keith/contracts'
import {
  DREAM_SKIP_TEXT,
  expiryTextOf,
  reasonTextOf,
  runOutcomeOf,
  stagedExpiresAtOf,
  statusRowsOf,
} from './dream-state.ts'

describe('dream skip reasons', () => {
  test('every skip reason has a plain sentence in DREAM_SKIP_TEXT', () => {
    for (const reason of DREAM_SKIP_REASONS) {
      const text = DREAM_SKIP_TEXT[reason]
      expect(typeof text, reason).toBe('string')
      expect(text.trim().length, reason).toBeGreaterThan(0)
    }
  })

  test('budget-low reads as the budget sentence', () => {
    expect(reasonTextOf('budget-low')).toBe('Skipped: your budget is nearly used up.')
  })

  test('a failed run toast names its cause; a failure with no reason names the error', () => {
    const counts = { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 }
    expect(
      runOutcomeOf({ status: 'failed', reason: 'turn-error', counts } as DreamRunView).text,
    ).toBe('Dream run failed: the model turn failed.')
    expect(runOutcomeOf({ status: 'failed', reason: null, counts } as DreamRunView).text).toBe(
      'Dream run failed: an unexpected error stopped the run.',
    )
  })

  test('a refused run toast names its cause', () => {
    const counts = { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 }
    expect(
      runOutcomeOf({ status: 'refused', reason: 'no-model', counts } as DreamRunView).text,
    ).toBe('Dream run refused: no model for the cortex role.')
  })

  test('a skipped run toast is the sentence alone', () => {
    const run = {
      status: 'skipped',
      reason: 'budget-low',
      counts: { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 },
    } as unknown as DreamRunView
    expect(runOutcomeOf(run).text).toBe('Skipped: your budget is nearly used up.')
  })
})

describe('the expiry of a waiting plan (FR3-18)', () => {
  const DAY = 86_400_000
  const T = Date.UTC(2026, 10, 11, 12)

  test('expiryTextOf counts the days left; a part of a day counts as a day, and none left is today', () => {
    expect(expiryTextOf(T + 3 * DAY, T)).toBe('expires in 3 days')
    expect(expiryTextOf(T + DAY, T)).toBe('expires in 1 day')
    expect(expiryTextOf(T + 1000, T)).toBe('expires in 1 day')
    expect(expiryTextOf(T, T)).toBe('expires today')
    expect(expiryTextOf(T - DAY, T)).toBe('expires today')
  })

  test('a plan ends 7 days after its run ended', () => {
    expect(stagedExpiresAtOf(T)).toBe(T + 7 * DAY)
  })

  test('the status rows name the expiry of a waiting plan; none once there is no plan', () => {
    const base = {
      mode: 'propose' as const,
      lastRun: null,
      nextRunAt: null,
      canUndo: false,
    }
    const waiting = statusRowsOf({
      ...base,
      canApply: true,
      stagedExpiresAt: Date.now() + 3 * DAY,
    })
    expect(waiting).toContain('A staged plan waits: /dream apply (expires in 3 days).')
    const applied = statusRowsOf({ ...base, canApply: false })
    expect(applied.some((row) => row.startsWith('A staged plan waits'))).toBe(false)
  })
})
