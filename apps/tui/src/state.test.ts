import { describe, expect, test } from 'bun:test'
import { type CoreFrame, type FrameData, type MessageDto, makeFrame, type ThreadDto } from '@keith/protocol'
import { applyFrame, applyLocal, type ChatState, initialState, type MessageEntry } from './state.ts'

const threadId = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31'
const otherThread = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V99'
const messageId = 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33'
const person = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' } as const
const thread: ThreadDto = {
  id: threadId,
  kind: 'direct',
  title: 'main',
  participants: [person],
  state: 'idle',
  updatedAt: 1,
}

let n = 0
function frame<T extends CoreFrame['type']>(type: T, data: FrameData<T>): CoreFrame {
  n += 1
  return makeFrame(type, data, { id: `f${n}`, ts: 1 }) as CoreFrame
}

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: messageId,
    threadId,
    role: 'assistant',
    authorPersonId: null,
    modality: 'text',
    content: 'Hello sir.',
    createdAt: 1,
    ...overrides,
  }
}

function apply(state: ChatState, ...frames: CoreFrame[]): ChatState {
  return frames.reduce(applyFrame, state)
}

function opened(messages: MessageDto[] = []): ChatState {
  return apply(initialState(), frame('thread.opened', { thread, messages }))
}

describe('state reducer', () => {
  test('welcome sets the person and goes online', () => {
    const state = apply(
      initialState(),
      frame('welcome', {
        nodeId: 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y',
        person,
        protocol: 1,
        server: { name: 'keith', version: '0' },
      }),
    )
    expect(state.person).toEqual(person)
    expect(state.connection).toEqual({ kind: 'online' })
  })

  test('thread.opened renders history and the thread state', () => {
    const state = apply(
      initialState(),
      frame('thread.opened', { thread: { ...thread, state: 'thinking' }, messages: [message()] }),
    )
    expect(state.turnState).toBe('thinking')
    expect(state.entries).toMatchObject([
      { kind: 'message', id: messageId, text: 'Hello sir.', streaming: false },
    ])
  })

  test('streams deltas into one message and completes it', () => {
    const state = apply(
      opened(),
      frame('message.started', { threadId, messageId, proactive: false }),
      frame('message.delta', { threadId, messageId, text: 'Hel' }),
      frame('message.delta', { threadId, messageId, text: 'lo' }),
    )
    expect(state.entries).toMatchObject([{ text: 'Hello', streaming: true }])
    const done = apply(state, frame('message.completed', { message: message({ content: 'Hello!' }) }))
    expect(done.entries).toHaveLength(1)
    expect(done.entries).toMatchObject([{ text: 'Hello!', streaming: false }])
  })

  test('I-11: a proactive message.started renders as an unsolicited assistant message', () => {
    const state = apply(opened(), frame('message.started', { threadId, messageId, proactive: true }))
    expect(state.entries).toMatchObject([{ kind: 'message', role: 'assistant', proactive: true }])
    // The completed DTO without meta keeps the mark from message.started.
    const done = apply(state, frame('message.completed', { message: message() }))
    expect((done.entries[0] as MessageEntry).proactive).toBe(true)
  })

  test('a cancelled message is marked', () => {
    const state = apply(
      opened(),
      frame('message.completed', { message: message({ meta: { cancelled: true } }) }),
    )
    expect(state.entries).toMatchObject([{ cancelled: true }])
  })

  test('thread.state updates the turn indicator', () => {
    expect(apply(opened(), frame('thread.state', { threadId, state: 'speaking' })).turnState).toBe('speaking')
  })

  test('frames for another thread are ignored', () => {
    const before = opened()
    const after = apply(
      before,
      frame('thread.state', { threadId: otherThread, state: 'thinking' }),
      frame('message.started', { threadId: otherThread, messageId, proactive: false }),
    )
    expect(after).toEqual(before)
  })

  test('tool.activity is one line per tool call, updated in place', () => {
    const base = { threadId, messageId, toolCallId: 'c1', name: 'web.search' } as const
    const state = apply(
      opened(),
      frame('tool.activity', { ...base, status: 'started' }),
      frame('tool.activity', { ...base, status: 'completed', summary: '3 results' }),
    )
    expect(state.entries).toEqual([
      {
        kind: 'tool',
        key: 'tool:c1',
        toolCallId: 'c1',
        messageId,
        name: 'web.search',
        status: 'completed',
        summary: '3 results',
      },
    ])
  })

  test('notice and error frames become notices', () => {
    const state = apply(
      opened(),
      frame('notice', { level: 'warn', text: 'Provider switched.' }),
      frame('error', { code: 'PROVIDER_ERROR', message: 'upstream down' }),
    )
    expect(state.entries).toMatchObject([
      { kind: 'notice', level: 'warn', text: 'Provider switched.' },
      { kind: 'notice', level: 'error', text: 'PROVIDER_ERROR: upstream down' },
    ])
  })

  test('a local user message is shown immediately and replaced by the relayed copy', () => {
    const state = applyLocal(opened(), { type: 'sent', text: 'hi' })
    expect(state.entries).toMatchObject([{ role: 'user', text: 'hi', local: true }])
    const relayed = apply(
      state,
      frame('message.user', {
        message: message({
          id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V40',
          role: 'user',
          authorPersonId: person.id,
          content: 'hi',
        }),
      }),
    )
    expect(relayed.entries).toHaveLength(1)
    expect(relayed.entries).toMatchObject([
      { role: 'user', local: false, id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V40' },
    ])
  })

  test('message.user from another node is appended', () => {
    const state = apply(
      opened(),
      frame('message.user', { message: message({ role: 'user', content: 'from phone' }) }),
    )
    expect(state.entries).toMatchObject([{ role: 'user', text: 'from phone' }])
  })
})
