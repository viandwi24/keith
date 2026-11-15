import { describe, expect, test } from 'bun:test'
import type { ChatItem } from '@keith/app-model'
import { columnsFor, latestReply, subtitleLines, subtitleOf } from './subtitle.ts'

const assistant = (text: string): ChatItem => ({
  id: 'a',
  kind: 'assistant',
  proactive: false,
  stopped: false,
  blocks: [{ kind: 'text', text }],
})

describe('latestReply', () => {
  test('the newest assistant message, text blocks only; nothing after a user message', () => {
    expect(latestReply([{ id: 'u', kind: 'user', text: 'hi' }, assistant('Hello **you**')])).toBe(
      'Hello **you**',
    )
    expect(latestReply([assistant('old'), { id: 'u', kind: 'user', text: 'again' }])).toBe('')
    expect(latestReply([])).toBe('')
  })
})

describe('subtitleOf', () => {
  const base = { raw: '# Hi\n\nthere **you**', baseline: '', busy: false, idleMs: 0 }
  test('plain words while streaming and during the hold', () => {
    expect(subtitleOf({ ...base, busy: true })).toBe('Hi there you')
    expect(subtitleOf({ ...base, idleMs: 7_999 })).toBe('Hi there you')
  })
  test('cleared after the hold, and for a reply that was there before Home mounted', () => {
    expect(subtitleOf({ ...base, idleMs: 8_000 })).toBe('')
    expect(subtitleOf({ ...base, baseline: base.raw })).toBe('')
    expect(subtitleOf({ ...base, baseline: base.raw, busy: true })).toBe('Hi there you')
    expect(subtitleOf({ ...base, raw: '' })).toBe('')
  })
})

describe('rows', () => {
  test('columns from the width, never below 16', () => {
    expect(columnsFor(550, 10)).toBe(100)
    expect(columnsFor(40, 16)).toBe(16)
  })
  test('the newest two wrapped rows', () => {
    expect(subtitleLines('one two three four five six', 9)).toEqual(['four five', 'six'])
  })
})
