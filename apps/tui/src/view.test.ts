import { describe, expect, test } from 'bun:test'
import { initialState, type MessageEntry } from './state.ts'
import { entryText, entryView, PROACTIVE_PREFIX, statusLine, turnLabel } from './view.ts'

const assistant: MessageEntry = {
  kind: 'message',
  key: 'm1',
  id: 'm1',
  role: 'assistant',
  text: 'Hello sir.',
  proactive: false,
  streaming: false,
  cancelled: false,
  local: false,
}

describe('view', () => {
  test('turn state labels', () => {
    expect(turnLabel('thinking')).toBe('thinking…')
    expect(turnLabel('speaking')).toBe('speaking')
    expect(turnLabel('idle')).toBe('')
  })

  test('status line shows person, thread, connection and turn', () => {
    const state = {
      ...initialState(),
      connection: { kind: 'online' } as const,
      person: { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' } as const,
      turnState: 'thinking' as const,
    }
    expect(statusLine(state)).toBe('keith · Tony · online · thinking…')
    expect(statusLine({ ...state, connection: { kind: 'reconnecting', attempt: 2, inMs: 1000 } })).toContain(
      'reconnecting in 1s (attempt 2)',
    )
  })

  test('I-11: proactive messages carry the "Keith ▸" prefix', () => {
    expect(entryText({ ...assistant, proactive: true })).toBe(`${PROACTIVE_PREFIX}Hello sir.`)
    expect(entryText(assistant)).not.toContain('▸')
  })

  test('streaming and cancelled marks', () => {
    expect(entryText({ ...assistant, streaming: true })).toEndWith('▍')
    expect(entryText({ ...assistant, cancelled: true })).toEndWith('(cancelled)')
  })

  test('tool activity is a dim line', () => {
    const view = entryView({
      kind: 'tool',
      key: 't',
      toolCallId: 'c1',
      messageId: 'm1',
      name: 'web.search',
      status: 'failed',
      summary: 'timeout',
    })
    expect(view.segments).toEqual([{ text: '  ⚙ web.search ✗ timeout', style: 'tool-failed' }])
  })
})
