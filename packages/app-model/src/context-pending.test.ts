import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_PENDING_TEXT,
  type ContextPendingState,
  draftRestoredOf,
  INITIAL_CONTEXT_PENDING,
  pendingKindOf,
  reduceContextPending,
} from './context-pending.ts'

const fold = (events: Parameters<typeof reduceContextPending>[1][]): ContextPendingState =>
  events.reduce(reduceContextPending, INITIAL_CONTEXT_PENDING)

describe('the pending state of a context change', () => {
  test('this TUI own command shows at once and clears when it settles', () => {
    const started = fold([{ type: 'local-start', kind: 'compact' }])
    expect(pendingKindOf(started)).toBe('compact')
    const settled = reduceContextPending(started, { type: 'local-end', kind: 'compact' })
    expect(pendingKindOf(settled)).toBeUndefined()
    expect(settled.compacted).toBe(1)
  })

  test('a change of the person another TUI runs shows from its start record to its end record', () => {
    const start = fold([{ type: 'feed', record: { kind: 'new', state: 'start' } }])
    expect(pendingKindOf(start)).toBe('new')
    const end = reduceContextPending(start, {
      type: 'feed',
      record: { kind: 'new', state: 'end', ok: true },
    })
    expect(pendingKindOf(end)).toBeUndefined()
    expect(end.compacted).toBe(0)
  })

  test('a fed end of a compaction is a refetch trigger too', () => {
    const state = fold([
      { type: 'feed', record: { kind: 'compact', state: 'start' } },
      { type: 'feed', record: { kind: 'compact', state: 'end', ok: false } },
    ])
    expect(pendingKindOf(state)).toBeUndefined()
    expect(state.compacted).toBe(1)
  })

  test('the local command wins over the feed, and a resync forgets only the feed', () => {
    const state = fold([
      { type: 'feed', record: { kind: 'new', state: 'start' } },
      { type: 'local-start', kind: 'compact' },
    ])
    expect(pendingKindOf(state)).toBe('compact')
    const resynced = reduceContextPending(state, { type: 'resync' })
    expect(resynced.feed).toBeUndefined()
    expect(pendingKindOf(resynced)).toBe('compact')
  })

  test('each kind has its row text', () => {
    expect(CONTEXT_PENDING_TEXT).toEqual({
      new: 'starting a new context…',
      compact: 'compacting the conversation…',
    })
  })
})

describe('the draft after a refused send', () => {
  test('the refused text comes back; text typed since stays after it', () => {
    expect(draftRestoredOf('', 'hello')).toBe('hello')
    expect(draftRestoredOf('next', 'hello')).toBe('hello\nnext')
  })
})

describe('a resync', () => {
  test("keeps this TUI's own running command: the feed sends no history, the call ends when it settles or at the deadline", () => {
    const state = fold([{ type: 'local-start', kind: 'compact' }])
    expect(pendingKindOf(state)).toBe('compact')
    const resynced = reduceContextPending(state, { type: 'resync' })
    expect(pendingKindOf(resynced)).toBe('compact')
  })
})
