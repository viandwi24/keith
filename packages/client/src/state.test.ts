import { describe, expect, test } from 'bun:test'
import { type CoreFrame, type FrameData, type MessageDto, makeFrame, type ThreadDto } from '@keith/protocol'
import {
  applyFrame,
  applyLocal,
  authorName,
  type ChatState,
  initialState,
  isHiddenEntry,
  type MessageEntry,
  oldestMessageId,
  relayFrom,
} from './state.ts'

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

describe('ui.render blocks', () => {
  const card = { type: 'card', id: 'weather', title: 'Paris', body: '22°C' } as const
  const markdown = { type: 'markdown', id: 'note', text: '**done**' } as const

  test('attach to their message, one per block id, replaced in place', () => {
    const state = apply(
      opened(),
      frame('message.started', { threadId, messageId, proactive: false }),
      frame('ui.render', { threadId, messageId, block: card, fallbackText: 'Paris 22°C' }),
      frame('ui.render', { threadId, messageId, block: markdown, fallbackText: 'done' }),
      frame('ui.render', {
        threadId,
        messageId,
        block: { ...card, body: '23°C' },
        fallbackText: 'Paris 23°C',
      }),
    )
    const entry = state.entries[0] as MessageEntry
    expect(state.entries).toHaveLength(1)
    expect(entry.ui).toEqual([
      { block: { ...card, body: '23°C' }, fallbackText: 'Paris 23°C' },
      { block: markdown, fallbackText: 'done' },
    ])
  })

  test('survive message.completed without ui, and come from the DTO when it has them', () => {
    const streamed = apply(
      opened(),
      frame('message.started', { threadId, messageId, proactive: false }),
      frame('ui.render', { threadId, messageId, block: card, fallbackText: 'Paris 22°C' }),
    )
    const kept = apply(streamed, frame('message.completed', { message: message() }))
    expect((kept.entries[0] as MessageEntry).ui).toEqual([{ block: card, fallbackText: 'Paris 22°C' }])
    const fromDto = apply(streamed, frame('message.completed', { message: message({ ui: [markdown] }) }))
    expect((fromDto.entries[0] as MessageEntry).ui).toEqual([{ block: markdown, fallbackText: '**done**' }])
  })

  test('history messages carry their blocks with derived fallback text', () => {
    const state = opened([message({ ui: [card] })])
    expect((state.entries[0] as MessageEntry).ui).toEqual([{ block: card, fallbackText: 'Paris\n22°C' }])
  })

  test('a block before message.started opens the message; one without messageId floats', () => {
    const state = apply(
      opened(),
      frame('ui.render', { threadId, messageId, block: card, fallbackText: 'Paris' }),
      frame('message.started', { threadId, messageId, proactive: true }),
      frame('ui.render', { threadId, block: markdown, fallbackText: 'done' }),
      frame('ui.render', { threadId: otherThread, block: markdown, fallbackText: 'done' }),
    )
    expect(state.entries).toMatchObject([
      { kind: 'message', id: messageId, proactive: true, streaming: true, ui: [{ block: card }] },
      { kind: 'ui', block: markdown, fallbackText: 'done' },
    ])
  })
})

describe('history paging', () => {
  test('an older page is prepended once, and the cursor is the oldest core message', () => {
    const older = message({ id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V20', content: 'older' })
    const state = applyLocal(opened([message()]), { type: 'sent', text: 'local' })
    expect(oldestMessageId(state)).toBe(messageId)
    const paged = applyLocal(state, { type: 'history.page', messages: [older, message()], hasMore: false })
    expect(paged.entries.map((e) => (e.kind === 'message' ? e.text : e.kind))).toEqual([
      'older',
      'Hello sir.',
      'local',
    ])
    expect(paged.history).toEqual({ hasMore: false, loading: false })
    expect(oldestMessageId(paged)).toBe(older.id)
  })
})

describe('isHiddenEntry', () => {
  const step: MessageEntry = {
    kind: 'message',
    key: messageId,
    id: messageId,
    role: 'assistant',
    text: '',
    proactive: false,
    streaming: false,
    cancelled: false,
    local: false,
    ui: [],
  }

  test('an assistant tool step without text or blocks is hidden', () => {
    expect(isHiddenEntry(step)).toBe(true)
    expect(isHiddenEntry({ ...step, text: ' \n' })).toBe(true)
  })

  test('text, blocks, streaming, cancelled, user rows and other entries are shown', () => {
    expect(isHiddenEntry({ ...step, text: 'hi' })).toBe(false)
    expect(isHiddenEntry({ ...step, streaming: true })).toBe(false)
    expect(isHiddenEntry({ ...step, cancelled: true })).toBe(false)
    expect(isHiddenEntry({ ...step, role: 'user' })).toBe(false)
    const ui = [{ block: { type: 'markdown', id: 'x', text: 'x' } as const, fallbackText: 'x' }]
    expect(isHiddenEntry({ ...step, ui })).toBe(false)
    expect(isHiddenEntry({ kind: 'notice', key: 'n', level: 'info', text: '' })).toBe(false)
  })
})

describe('phase 5: thread list', () => {
  const pepper = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V40', name: 'Pepper', tier: 'member' } as const
  const rhodey = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V41', name: 'Rhodey', tier: 'guest' } as const
  const happy = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V42', name: 'Happy', tier: 'member' } as const
  const group: ThreadDto = {
    id: otherThread,
    kind: 'group',
    title: 'Mission',
    participants: [person, pepper],
    state: 'idle',
    updatedAt: 5,
    purpose: 'Plan the Expo launch.',
  }
  const third: ThreadDto = { ...group, id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V98', title: 'Party', updatedAt: 3 }
  const ids = (state: ChatState) => state.threads.map((t) => t.id)

  test('starts empty, and thread.opened adds the open thread', () => {
    expect(initialState().threads).toEqual([])
    expect(opened().threads).toEqual([thread])
  })

  test('the loaded list is sorted by most recent update', () => {
    const state = applyLocal(opened(), { type: 'threads', threads: [thread, third, group] })
    expect(ids(state)).toEqual([group.id, third.id, threadId])
  })

  test('thread.updated adds a thread, or replaces it, and keeps the order', () => {
    const loaded = applyLocal(opened(), { type: 'threads', threads: [thread, third] })
    const added = apply(loaded, frame('thread.updated', { thread: group }))
    expect(ids(added)).toEqual([group.id, third.id, threadId])

    const joined = { ...third, participants: [person, pepper, rhodey], updatedAt: 9 }
    const replaced = apply(added, frame('thread.updated', { thread: joined }))
    expect(ids(replaced)).toEqual([third.id, group.id, threadId])
    expect(replaced.threads[0]).toEqual(joined)
    expect(replaced.threads).toHaveLength(3)
    // The open conversation is untouched by another thread's update.
    expect(replaced.thread).toEqual(thread)
    expect(replaced.entries).toBe(loaded.entries)
  })

  test('thread.updated of the open thread refreshes its participants and keeps the conversation', () => {
    const open = apply(
      initialState(),
      frame('thread.opened', { thread: group, messages: [message({ threadId: otherThread })] }),
      frame('thread.state', { threadId: otherThread, state: 'thinking' }),
    )
    const updated = { ...group, participants: [person, pepper, rhodey], updatedAt: 7 }
    const state = apply(open, frame('thread.updated', { thread: updated }))
    expect(state.thread).toEqual(updated)
    expect(state.turnState).toBe('thinking')
    expect(state.entries).toBe(open.entries)
  })

  test('thread.removed drops the thread from the list', () => {
    const loaded = applyLocal(opened(), { type: 'threads', threads: [thread, group, third] })
    const state = apply(loaded, frame('thread.removed', { threadId: otherThread }))
    expect(ids(state)).toEqual([third.id, threadId])
    expect(state.thread).toEqual(thread)
    // An unknown thread changes nothing.
    const same = apply(state, frame('thread.removed', { threadId: otherThread }))
    expect(same).toBe(state)
  })

  test('thread.removed of the open thread closes the conversation', () => {
    const open = apply(
      initialState(),
      frame('thread.opened', { thread: group, messages: [message({ threadId: otherThread })] }),
    )
    const state = apply(open, frame('thread.removed', { threadId: otherThread }))
    expect(state.thread).toBeNull()
    expect(state.entries).toEqual([])
    expect(state.threads).toEqual([])
    expect(state.turnState).toBe('idle')
    // Its late frames are ignored.
    const late = apply(
      state,
      frame('message.started', { threadId: otherThread, messageId, proactive: false }),
    )
    expect(late).toBe(state)
  })

  test('thread.closed clears the conversation but keeps the list', () => {
    const state = applyLocal(opened([message()]), { type: 'thread.closed' })
    expect(state.thread).toBeNull()
    expect(state.entries).toEqual([])
    expect(state.threads).toEqual([thread])
  })

  test('authorName: current participants, former participants, the Mind and unknown ids', () => {
    const withFormer = { ...group, formerParticipants: [happy] }
    const state = apply(
      initialState(),
      frame('thread.opened', {
        thread: withFormer,
        messages: [
          message({
            id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V50',
            threadId: otherThread,
            role: 'user',
            authorPersonId: pepper.id,
          }),
          message({
            id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V51',
            threadId: otherThread,
            role: 'user',
            authorPersonId: happy.id,
          }),
          message({ id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V52', threadId: otherThread }),
          message({
            id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V53',
            threadId: otherThread,
            role: 'user',
            authorPersonId: rhodey.id,
          }),
        ],
      }),
    )
    const names = state.entries.map((e) => authorName(state, e as MessageEntry))
    expect(names).toEqual(['Pepper', 'Happy', null, 'Someone'])
    // A MessageDto works too.
    expect(authorName(state, message({ role: 'user', authorPersonId: pepper.id }))).toBe('Pepper')
  })

  test('authorName: a local echo is the signed-in person', () => {
    const welcomed = apply(
      initialState(),
      frame('welcome', {
        nodeId: 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y',
        person,
        protocol: 1,
        server: { name: 'keith', version: '0' },
      }),
      frame('thread.opened', { thread: group, messages: [] }),
    )
    const state = applyLocal(welcomed, { type: 'sent', text: 'hi' })
    const entry = state.entries[0] as MessageEntry
    expect(entry.authorPersonId).toBe(person.id)
    expect(authorName(state, entry)).toBe('Tony')
    // Entries built without an author id (before phase 5).
    const { authorPersonId: _, ...legacy } = entry
    expect(authorName(state, legacy)).toBe('Tony')
    expect(authorName(state, { ...legacy, role: 'assistant' })).toBeNull()
  })

  test('relayFrom: the sender names of a relayed message, from an entry or a DTO', () => {
    const senders = [
      { personId: pepper.id, name: 'Pepper' },
      { personId: rhodey.id, name: 'Rhodey' },
    ]
    const relayed = message({ meta: { proactive: true, relayFrom: senders } })
    const state = apply(opened(), frame('message.completed', { message: relayed }))
    const entry = state.entries[0] as MessageEntry
    expect(entry.relayFrom).toEqual(senders)
    expect(entry.authorPersonId).toBeNull()
    expect(relayFrom(entry)).toEqual(['Pepper', 'Rhodey'])
    expect(relayFrom(relayed)).toEqual(['Pepper', 'Rhodey'])
    expect(relayFrom(message())).toEqual([])
    const plain = apply(opened(), frame('message.completed', { message: message() }))
      .entries[0] as MessageEntry
    expect(plain.relayFrom).toBeUndefined()
    expect(relayFrom(plain)).toEqual([])
  })
})
