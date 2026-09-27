import { describe, expect, test } from 'bun:test'
import type { MessageDto, PersonDto, ThreadDto } from '../dto.ts'
import { type AnyFrame, type FrameData, type FrameType, makeFrame } from '../envelope.ts'
import { CORE_FRAME_TYPES, CoreFrame, parseCoreFrame } from './core-to-node.ts'
import { INPUT_TEXT_MAX_CHARS, NODE_FRAME_TYPES, NodeFrame, parseNodeFrame } from './node-to-core.ts'

const threadId = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31'
const messageId = 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33'
const person: PersonDto = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' }
const thread: ThreadDto = {
  id: threadId,
  kind: 'direct',
  title: 'main',
  participants: [person],
  state: 'idle',
  updatedAt: 1790000000000,
}
const message: MessageDto = {
  id: messageId,
  threadId,
  role: 'assistant',
  authorPersonId: null,
  modality: 'text',
  content: 'The venue shortlist is ready.',
  createdAt: 1790000900000,
  meta: { proactive: true },
}

/** One valid payload per frame type (phases 1 and 2). */
const samples: { [T in FrameType]: FrameData<T> } = {
  hello: { protocol: 1, client: { name: 'keith-tui', version: '0.1.0' }, capabilities: ['chat.text@1'] },
  'thread.open': { historyLimit: 20 },
  'thread.close': { threadId },
  'input.text': { threadId, text: 'Research venue options.' },
  'input.cancel': { threadId },
  'ui.action': { threadId, messageId, blockId: 'confirm', actionId: 'book', value: { venue: 'riverside' } },
  pong: {},
  welcome: {
    nodeId: 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y',
    person,
    protocol: 1,
    server: { name: 'keith', version: '0.1.0' },
  },
  'thread.opened': { thread, messages: [message] },
  'thread.state': { threadId, state: 'thinking' },
  'message.user': { message: { ...message, role: 'user', authorPersonId: person.id, meta: undefined } },
  'message.started': { threadId, messageId, proactive: true },
  'message.delta': { threadId, messageId, text: 'The venue' },
  'message.completed': { message },
  'tool.activity': {
    threadId,
    messageId,
    toolCallId: 'call_1',
    name: 'task.start',
    status: 'started',
    summary: 'starting research',
  },
  'ui.render': {
    threadId,
    messageId,
    block: { type: 'markdown', id: 'note', text: '**done**' },
    fallbackText: 'done',
  },
  notice: { level: 'info', text: 'Provider switched to fallback.' },
  error: { code: 'INVALID_FRAME', message: 'input.text: text is required' },
  ping: {},
}

const nodeTypes = new Set<string>(NODE_FRAME_TYPES)

function roundTrip(frame: AnyFrame) {
  const json = JSON.stringify(frame)
  return nodeTypes.has(frame.type) ? parseNodeFrame(json) : parseCoreFrame(json)
}

describe('frame round trip', () => {
  test('there is a sample for every frame type', () => {
    expect(Object.keys(samples).sort()).toEqual([...NODE_FRAME_TYPES, ...CORE_FRAME_TYPES].sort())
  })

  for (const type of Object.keys(samples) as FrameType[]) {
    test(`${type}: makeFrame → JSON → parse returns the same frame`, () => {
      const frame = makeFrame(type, samples[type], {
        id: '01J8ZQ3K4M5N6P7Q8R9S0T1V40',
        ts: 1790000000000,
        re: 'r1',
      })
      const result = roundTrip(frame)
      expect(result).toEqual({ ok: true, frame: JSON.parse(JSON.stringify(frame)) })
    })
  }
})

describe('direction', () => {
  test('a core frame sent to the core is UNKNOWN_FRAME', () => {
    const frame = makeFrame('ping', {}, { id: 'f1', ts: 1 })
    expect(parseNodeFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: 'UNKNOWN_FRAME',
      frameId: 'f1',
    })
  })
  test('a node frame sent to a node is UNKNOWN_FRAME', () => {
    const frame = makeFrame('pong', {}, { id: 'f1', ts: 1 })
    expect(parseCoreFrame(frame)).toMatchObject({ ok: false, code: 'UNKNOWN_FRAME' })
  })
  test('the unions accept only their own direction', () => {
    expect(NodeFrame.safeParse(makeFrame('ping', {}, { id: 'a', ts: 1 })).success).toBe(false)
    expect(CoreFrame.safeParse(makeFrame('ping', {}, { id: 'a', ts: 1 })).success).toBe(true)
  })
})

function node(type: string, data: unknown) {
  return parseNodeFrame({ v: 1, type, id: 'f1', ts: 1, data })
}
function core(type: string, data: unknown) {
  return parseCoreFrame({ v: 1, type, id: 'f1', ts: 1, data })
}

describe('invalid node frames', () => {
  test.each([
    ['hello without client', 'hello', { protocol: 1, capabilities: [] }],
    ['hello with a malformed capability', 'hello', { ...samples.hello, capabilities: ['chat text'] }],
    ['hello with a nodeId of the wrong prefix', 'hello', { ...samples.hello, nodeId: threadId }],
    ['thread.open with a message id', 'thread.open', { threadId: messageId }],
    ['thread.open with historyLimit over 200', 'thread.open', { historyLimit: 201 }],
    ['thread.close without threadId', 'thread.close', {}],
    ['input.text with empty text', 'input.text', { threadId, text: '' }],
    ['input.text over the limit', 'input.text', { threadId, text: 'x'.repeat(INPUT_TEXT_MAX_CHARS + 1) }],
    ['input.cancel with a bad id', 'input.cancel', { threadId: 'thr_123' }],
    ['ui.action without actionId', 'ui.action', { threadId, messageId, blockId: 'a' }],
  ])('%s → INVALID_FRAME', (_name, type, data) => {
    expect(node(type, data)).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
  })

  test('input.text at exactly the limit is valid', () => {
    expect(node('input.text', { threadId, text: 'x'.repeat(INPUT_TEXT_MAX_CHARS) }).ok).toBe(true)
  })

  test('hello with protocol 2 → UNSUPPORTED_PROTOCOL', () => {
    expect(node('hello', { ...samples.hello, protocol: 2 })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_PROTOCOL',
    })
  })
})

describe('invalid core frames', () => {
  test.each([
    ['welcome without nodeId', 'welcome', { person: null, protocol: 1, server: { name: 'k', version: '1' } }],
    [
      'thread.opened with a thread without participants',
      'thread.opened',
      { thread: { ...thread, participants: [] }, messages: [] },
    ],
    ['thread.state with an unknown state', 'thread.state', { threadId, state: 'sleeping' }],
    ['message.user with a tool message', 'message.user', { message: { ...message, role: 'tool' } }],
    ['message.started without proactive', 'message.started', { threadId, messageId }],
    ['message.delta without text', 'message.delta', { threadId, messageId }],
    [
      'message.completed with audio modality typo',
      'message.completed',
      { message: { ...message, modality: 'voice' } },
    ],
    [
      'tool.activity with an unknown status',
      'tool.activity',
      { ...samples['tool.activity'], status: 'running' },
    ],
    [
      'ui.render with an invalid block',
      'ui.render',
      { threadId, block: { type: 'video', id: 'v' }, fallbackText: '' },
    ],
    [
      'ui.render without fallbackText',
      'ui.render',
      { threadId, block: { type: 'markdown', id: 'a', text: 'x' } },
    ],
    ['notice with level error', 'notice', { level: 'error', text: 'x' }],
    ['error with an unknown code', 'error', { code: 'OOPS', message: 'x' }],
  ])('%s → INVALID_FRAME', (_name, type, data) => {
    expect(core(type, data)).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
  })

  test('welcome for a headless node has person null', () => {
    expect(core('welcome', { ...samples.welcome, person: null }).ok).toBe(true)
  })
})

test('unknown data fields are dropped, not rejected (additive changes stay compatible)', () => {
  const result = core('thread.state', { threadId, state: 'idle', futureField: 1 })
  expect(result).toMatchObject({ ok: true, frame: { data: { threadId, state: 'idle' } } })
  if (result.ok) expect('futureField' in result.frame.data).toBe(false)
})
