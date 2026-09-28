import { describe, expect, test } from 'bun:test'
import { type ChatState, initialState, type MessageEntry } from '@keith/client'
import type { PersonDto, ThreadDto } from '@keith/protocol'
import {
  entryText,
  entryView,
  entryViews,
  HISTORY_LOADING,
  HISTORY_MORE,
  HISTORY_START,
  historyLine,
  PROACTIVE_PREFIX,
  parseCommand,
  statusLine,
  threadList,
  threadListLines,
} from './view.ts'

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
  ui: [],
}

describe('view', () => {
  test('history line: more, loading, start, nothing before a thread is open', () => {
    const thread: ThreadDto = {
      id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z',
      kind: 'direct',
      title: 'main',
      participants: [],
      state: 'idle',
      updatedAt: 1,
    }
    const state: ChatState = { ...initialState(), thread }
    expect(historyLine(initialState())).toBe('')
    expect(historyLine({ ...state, history: { hasMore: true, loading: false } })).toBe(HISTORY_MORE)
    expect(historyLine({ ...state, history: { hasMore: true, loading: true } })).toBe(HISTORY_LOADING)
    expect(historyLine({ ...state, history: { hasMore: false, loading: false } })).toBe(HISTORY_START)
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

  test('a floating UI block shows its fallback text', () => {
    const block = { type: 'markdown', id: 'n', text: 'Rain at 4pm' } as const
    expect(entryText({ kind: 'ui', key: 'ui:1', block, fallbackText: 'Rain at 4pm' })).toBe('Rain at 4pm')
  })

  test('history tool steps (assistant rows without text or blocks) are not shown', () => {
    const step: MessageEntry = { ...assistant, key: 'm0', id: 'm0', text: '' }
    const state = { ...initialState(), entries: [step, assistant] }
    expect(entryViews(state).map((v) => v.key)).toEqual(['m1'])
    // Still streaming: shown (the text is on its way).
    expect(entryViews({ ...state, entries: [{ ...step, streaming: true }] })).toHaveLength(1)
  })

  test("a reply with blocks but no text shows the blocks' fallback text", () => {
    const block = { type: 'markdown', id: 'n', text: 'Rain at 4pm' } as const
    const entry: MessageEntry = { ...assistant, text: '', ui: [{ block, fallbackText: 'Rain at 4pm' }] }
    expect(entryText(entry)).toContain('Rain at 4pm')
    expect(entryViews({ ...initialState(), entries: [entry] })).toHaveLength(1)
  })
})

describe('view, phase 5', () => {
  const tony: PersonDto = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V21', name: 'Tony', tier: 'owner' }
  const pepper: PersonDto = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V22', name: 'Pepper', tier: 'member' }
  const main: ThreadDto = {
    id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V21',
    kind: 'direct',
    title: 'main',
    participants: [tony],
    state: 'idle',
    updatedAt: 1,
  }
  const group: ThreadDto = {
    id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V22',
    kind: 'group',
    title: 'Mission',
    participants: [tony, pepper],
    state: 'idle',
    updatedAt: 5,
  }
  const inGroup: ChatState = { ...initialState(), person: tony, thread: group, threads: [group, main] }
  const user: MessageEntry = { ...assistant, key: 'u1', id: 'u1', role: 'user', text: 'Hi.' }

  test('the status bar shows the open thread label', () => {
    expect(statusLine(inGroup)).toBe('keith · Tony · Mission · Pepper · connecting…')
    expect(statusLine({ ...inGroup, thread: main })).toBe('keith · Tony · Main · connecting…')
  })

  test('in a group, other people\'s lines carry their name, mine stay "You"', () => {
    expect(entryText({ ...user, authorPersonId: pepper.id }, inGroup)).toBe('Pepper: Hi.')
    expect(entryText({ ...user, authorPersonId: tony.id }, inGroup)).toBe('You    Hi.')
    // A local echo has no author id yet.
    expect(entryText(user, inGroup)).toBe('You    Hi.')
    // Direct threads never show names.
    expect(entryText({ ...user, authorPersonId: pepper.id }, { ...inGroup, thread: main })).toBe('You    Hi.')
    expect(entryView({ ...user, authorPersonId: pepper.id }, inGroup).segments[0]?.style).toBe('author')
  })

  test('a relay is marked "(via Tony)"', () => {
    const relay = { ...assistant, proactive: true, relayFrom: [{ personId: tony.id, name: 'Tony' }] }
    expect(entryText(relay)).toBe(`${PROACTIVE_PREFIX}(via Tony) Hello sir.`)
    const two = { ...relay, relayFrom: [...relay.relayFrom, { personId: pepper.id, name: 'Pepper' }] }
    expect(entryText(two)).toContain('(via Tony, Pepper) ')
  })

  test('the thread list: Main first, numbered, the open one marked', () => {
    expect(threadList(inGroup).map((i) => [i.n, i.label, i.open])).toEqual([
      [1, 'Main', false],
      [2, 'Mission · Pepper', true],
    ])
    expect(threadListLines(inGroup).slice(0, 2)).toEqual(['  1  Main', '• 2  Mission · Pepper'])
    expect(threadListLines(initialState())[0]).toBe('No threads yet.')
  })

  test('commands: /threads and /open <n>, anything else is a message', () => {
    expect(parseCommand(' /threads ')).toEqual({ kind: 'threads' })
    expect(parseCommand('/open 2')).toEqual({ kind: 'open', n: 2 })
    expect(parseCommand('/open')).toEqual({ kind: 'open', n: null })
    expect(parseCommand('/open two')).toEqual({ kind: 'open', n: null })
    expect(parseCommand('/opens 2')).toBeNull()
    expect(parseCommand('/help me')).toBeNull()
    expect(parseCommand('hello')).toBeNull()
  })
})
