import { describe, expect, test } from 'bun:test'
import { PHASE_TEXT, phaseOf, progressKey, STALL_MS } from './status.ts'

const base = {
  status: 'ready',
  busy: false,
  answering: false,
  lastProgressAt: 0,
  now: 1000,
} as const

describe('phaseOf', () => {
  test('nothing runs: idle', () => {
    expect(phaseOf(base)).toBe('idle')
    expect(phaseOf({ ...base, status: 'error' })).toBe('idle')
  })

  test('sent and nothing visible yet: thinking', () => {
    expect(phaseOf({ ...base, status: 'submitted' })).toBe('thinking')
    expect(phaseOf({ ...base, busy: true })).toBe('thinking')
    expect(phaseOf({ ...base, status: 'streaming' })).toBe('thinking')
  })

  test('streaming with an answer showing: streaming', () => {
    expect(phaseOf({ ...base, status: 'streaming', answering: true })).toBe('streaming')
  })

  test('no progress for STALL_MS while running: stalled', () => {
    const running = { ...base, status: 'streaming', answering: true } as const
    expect(phaseOf({ ...running, now: STALL_MS - 1 })).toBe('streaming')
    expect(phaseOf({ ...running, now: STALL_MS })).toBe('stalled')
    expect(phaseOf({ ...base, now: 10 * STALL_MS })).toBe('idle')
  })

  test('every phase but idle has words', () => {
    expect(PHASE_TEXT.idle).toBe('')
    expect(PHASE_TEXT.stalled).not.toBe('')
  })
})

describe('progressKey', () => {
  const part = (text: string) => ({ type: 'text', text })
  test('changes when text grows or a part is added; same for the same tail', () => {
    const a = progressKey([{ id: 'm1', parts: [part('he')] }])
    expect(progressKey([{ id: 'm1', parts: [part('he')] }])).toBe(a)
    expect(progressKey([{ id: 'm1', parts: [part('hello')] }])).not.toBe(a)
    expect(
      progressKey([
        { id: 'm1', parts: [part('he'), { type: 'tool-x', state: 'input-available' }] },
      ]),
    ).not.toBe(a)
    expect(progressKey([])).toBe('')
  })
})
