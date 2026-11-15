import { describe, expect, test } from 'bun:test'
import type { DreamDiaryOutput, DreamRunView, DreamStatusView } from '@keith/contracts'
import { dreamFailure, loadMemory, memoryViewOf } from './memory-view.ts'

const STARTED = new Date(2026, 10, 14, 3, 0).getTime()

const run = (over: Partial<DreamRunView> = {}): DreamRunView =>
  ({
    id: 'r1',
    trigger: 'schedule',
    mode: 'propose',
    status: 'staged',
    reason: null,
    startedAt: STARTED,
    finishedAt: STARTED + 1000,
    counts: { candidates: 3, promoted: 1, merged: 0, superseded: 1, dropped: 1 },
    ...over,
  }) as DreamRunView

const status = (over: Partial<DreamStatusView> = {}): DreamStatusView => ({
  mode: 'propose',
  lastRun: run(),
  nextRunAt: null,
  canApply: false,
  canUndo: false,
  ...over,
})

const diary = (text: string): DreamDiaryOutput => ({ date: '2026-11-14', text }) as DreamDiaryOutput

describe('loadMemory', () => {
  test('reads the status and the latest diary', async () => {
    const data = await loadMemory({
      status: async () => status(),
      diary: async () => diary('a\n\nb'),
    })
    expect(data.staged).toEqual([])
    expect(memoryViewOf(data).diaryLines).toEqual(['a', 'b'])
  })
  test('a missing diary is not an error', async () => {
    const data = await loadMemory({
      status: async () => status(),
      diary: async () => {
        throw Object.assign(new Error('none'), { code: 'NOT_FOUND' })
      },
    })
    expect(data.diary).toBeUndefined()
    expect(memoryViewOf(data).diaryTitle).toBeUndefined()
  })
  test('another failure of the diary is an error', async () => {
    await expect(
      loadMemory({
        status: async () => status(),
        diary: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
  })
  test('a staged plan reads its entries from the diary of the day its run started', async () => {
    const asked: (string | undefined)[] = []
    const data = await loadMemory({
      status: async () =>
        status({ canApply: true, stagedRunId: 'r1', stagedRunStartedAt: STARTED }),
      diary: async (input) => {
        asked.push(input?.date)
        return diary('## run r1\n- promote a\n- drop b\n## run r2\n- other')
      },
    })
    expect(asked).toEqual([undefined, '2026-11-14'])
    expect(data.staged).toEqual(['- promote a', '- drop b'])
  })
})

describe('memoryViewOf', () => {
  test('the staged plan says its counts and its expiry', () => {
    const view = memoryViewOf({
      status: status({
        canApply: true,
        stagedRunId: 'r1',
        stagedExpiresAt: Date.now() + 3 * 86_400_000 - 1000,
      }),
      diary: undefined,
      staged: ['- x'],
    })
    expect(view.plan).toMatchObject({
      runId: 'r1',
      counts: '3 candidates: 1 promoted, 0 merged, 1 superseded, 1 dropped',
      expiry: 'expires in 3 days',
      entries: ['- x'],
    })
  })
  test('no plan, no run', () => {
    const view = memoryViewOf({ status: status({ lastRun: null }), diary: undefined, staged: [] })
    expect(view.plan).toBeUndefined()
    expect(view.lastRun).toBe('none yet')
  })
})

describe('dreamFailure', () => {
  test('a refusal is a warning in plain words', () => {
    const error = Object.assign(new Error('conflict'), {
      code: 'CONFLICT',
      data: { reason: 'too-soon' },
    })
    expect(dreamFailure(error)).toEqual({
      text: 'too soon, the last run is less than 20 hours old',
      level: 'warning',
    })
  })
  test('another error keeps its message', () => {
    expect(dreamFailure(new Error('nope'))).toEqual({ text: 'nope', level: 'error' })
  })
})
