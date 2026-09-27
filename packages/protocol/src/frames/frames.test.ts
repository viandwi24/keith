import { describe, expect, test } from 'bun:test'
import type { MessageDto, PersonDto, ThreadDto } from '../dto.ts'
import { makeCoreFrame, makeFrame, makeNodeFrame } from '../envelope.ts'
import { CORE_FRAME_TYPES, CoreFrame, type CoreFrame as CoreFrameT, parseCoreFrame } from './core-to-node.ts'
import {
  INPUT_TEXT_MAX_CHARS,
  NODE_FRAME_TYPES,
  NodeFrame,
  type NodeFrame as NodeFrameT,
  parseNodeFrame,
} from './node-to-core.ts'

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

const streamId = '01J8ZQ3K4M5N6P7Q8R9S0T1V50'

type NodeSamples = { [T in NodeFrameT['type']]: Extract<NodeFrameT, { type: T }>['data'] }
type CoreSamples = { [T in CoreFrameT['type']]: Extract<CoreFrameT, { type: T }>['data'] }

/** One valid payload per node → core frame type. */
const nodeSamples: NodeSamples = {
  hello: { protocol: 1, client: { name: 'keith-tui', version: '0.1.0' }, capabilities: ['chat.text@1'] },
  'thread.open': { historyLimit: 20 },
  'thread.close': { threadId },
  'input.text': { threadId, text: 'Research venue options.' },
  'input.cancel': { threadId },
  'ui.action': { threadId, messageId, blockId: 'confirm', actionId: 'book', value: { venue: 'riverside' } },
  'audio.start': { threadId, streamId, codec: 'pcm16', sampleRate: 16_000 },
  'audio.end': { streamId },
  pong: {},
}

/** One valid payload per core → node frame type. */
const coreSamples: CoreSamples = {
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
  'audio.start': { threadId, messageId, streamId, codec: 'pcm16', sampleRate: 24_000 },
  'audio.end': { streamId },
  'audio.stop': { streamId },
}
const samples = { ...nodeSamples, ...coreSamples }

const opts = { id: '01J8ZQ3K4M5N6P7Q8R9S0T1V40', ts: 1790000000000, re: 'r1' }

describe('frame round trip', () => {
  test('there is a sample for every frame type', () => {
    expect(Object.keys(nodeSamples).sort()).toEqual([...NODE_FRAME_TYPES].sort())
    expect(Object.keys(coreSamples).sort()).toEqual([...CORE_FRAME_TYPES].sort())
  })

  for (const type of NODE_FRAME_TYPES) {
    test(`node ${type}: makeNodeFrame → JSON → parse returns the same frame`, () => {
      const frame = makeNodeFrame(type, nodeSamples[type], opts)
      const result = parseNodeFrame(JSON.stringify(frame))
      expect(result).toEqual({ ok: true, frame: JSON.parse(JSON.stringify(frame)) })
    })
  }

  for (const type of CORE_FRAME_TYPES) {
    test(`core ${type}: makeCoreFrame → JSON → parse returns the same frame`, () => {
      const frame = makeCoreFrame(type, coreSamples[type], opts)
      const result = parseCoreFrame(JSON.stringify(frame))
      expect(result).toEqual({ ok: true, frame: JSON.parse(JSON.stringify(frame)) })
    })
  }

  test('makeFrame builds the same frame as the directional helpers', () => {
    expect(makeFrame('ping', {}, opts)).toEqual(makeCoreFrame('ping', {}, opts))
    expect(makeFrame('pong', {}, opts)).toEqual(makeNodeFrame('pong', {}, opts))
  })
})

describe('audio frames (phase 3)', () => {
  test('node audio.start is not a valid core audio.start (it lacks messageId)', () => {
    expect(core('audio.start', nodeSamples['audio.start'])).toMatchObject({
      ok: false,
      code: 'INVALID_FRAME',
    })
  })
  test('core audio.start sent to the core parses as the node frame, dropping messageId', () => {
    const result = node('audio.start', coreSamples['audio.start'])
    expect(result.ok).toBe(true)
    if (result.ok) expect('messageId' in result.frame.data).toBe(false)
  })
  test('audio.stop is core → node only', () => {
    expect(node('audio.stop', { streamId })).toMatchObject({ ok: false, code: 'UNKNOWN_FRAME' })
  })
  test('the opus codec is valid on the wire (the v1 core refuses it itself)', () => {
    expect(node('audio.start', { ...nodeSamples['audio.start'], codec: 'opus' }).ok).toBe(true)
  })
  test('meta.spokenChars round-trips on a message', () => {
    const cut = { ...message, meta: { cancelled: true, spokenChars: 12 } }
    expect(core('message.completed', { message: cut })).toMatchObject({
      ok: true,
      frame: { data: { message: { meta: { cancelled: true, spokenChars: 12 } } } },
    })
  })
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
    [
      'audio.start with a prefixed streamId',
      'audio.start',
      { ...nodeSamples['audio.start'], streamId: threadId },
    ],
    ['audio.start with an unknown codec', 'audio.start', { ...nodeSamples['audio.start'], codec: 'mp3' }],
    ['audio.start with a sample rate of 0', 'audio.start', { ...nodeSamples['audio.start'], sampleRate: 0 }],
    [
      'audio.start with a sample rate of 96 kHz',
      'audio.start',
      { ...nodeSamples['audio.start'], sampleRate: 96_000 },
    ],
    ['audio.start without threadId', 'audio.start', { streamId, codec: 'pcm16', sampleRate: 16_000 }],
    ['audio.end without streamId', 'audio.end', {}],
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
    ['audio.stop without streamId', 'audio.stop', {}],
    ['audio.end with a bad streamId', 'audio.end', { streamId: 'x' }],
    [
      'message.completed with negative spokenChars',
      'message.completed',
      { message: { ...message, meta: { spokenChars: -1 } } },
    ],
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
