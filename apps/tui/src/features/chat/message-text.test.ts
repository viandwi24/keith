import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { COMPACTED_TEXT, noticeText, questionOf, toItems } from './message-text.ts'

test('chat items: user and Keith text, plus eharness notices with their level', () => {
  const messages = [
    { id: '1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    {
      id: '2',
      role: 'assistant',
      parts: [
        {
          type: 'data-eh.notice',
          data: { level: 'error', message: 'Unknown notice message' },
        },
      ],
    },
    { id: '3', role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] },
  ] as UIMessage[]
  expect(toItems(messages)).toEqual([
    { id: '1', kind: 'user', text: 'hello' },
    { id: '2:notice', kind: 'notice', level: 'error', text: 'Unknown notice message' },
    {
      id: '3',
      kind: 'assistant',
      proactive: false,
      stopped: false,
      blocks: [{ kind: 'text', text: 'Hello!' }],
    },
  ])
})

test('a message with the proactive data part is marked, others are not', () => {
  const messages = [
    {
      id: 'w',
      role: 'assistant',
      parts: [
        { type: 'data-keith.proactive', data: { taskId: 't1' } },
        { type: 'text', text: 'Sir, the search is done.' },
      ],
    },
    { id: 'n', role: 'assistant', parts: [{ type: 'text', text: 'Ordinary.' }] },
  ] as UIMessage[]
  const items = toItems(messages)
  expect(items.map((i) => i.kind === 'assistant' && i.proactive)).toEqual([true, false])
})

test('text and tool calls of one assistant message keep their order', () => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me ' },
        { type: 'text', text: 'check.' },
        { type: 'step-start' },
        {
          type: 'tool-motor_remote',
          toolCallId: 'c1',
          state: 'output-available',
          input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
          output: { ok: true, output: '91%' },
        },
        { type: 'text', text: '  Done.  ' },
      ],
    },
  ] as unknown as UIMessage[]
  const [item] = toItems(messages)
  expect(item?.kind).toBe('assistant')
  const blocks = item?.kind === 'assistant' ? item.blocks : []
  expect(blocks.map((b) => (b.kind === 'text' ? b.text : `tool:${b.call.name}`))).toEqual([
    'Let me check.',
    'tool:motor_remote',
    'Done.',
  ])
})

test('an empty assistant message is dropped; a stop of aborted marks the message stopped', () => {
  const messages = [
    { id: 'e', role: 'assistant', parts: [] },
    {
      id: 's',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Half an' }],
      metadata: { eharness: { stop: 'aborted' } },
    },
  ] as unknown as UIMessage[]
  const items = toItems(messages)
  expect(items).toHaveLength(1)
  expect(items[0]?.kind === 'assistant' && items[0].stopped).toBe(true)
})

test('known eharness notices are shown in Indonesian, by code first, then by exact text', () => {
  const interrupted = 'The previous turn was interrupted: its process stopped before it finished.'
  expect(noticeText({ code: 'EH_TURN_INTERRUPTED', message: 'anything' })).toBe(interrupted)
  expect(
    noticeText({
      message: 'The previous turn was interrupted: its process stopped before it finished.',
    }),
  ).toBe(interrupted)
  expect(noticeText({ code: 'EH_TURN_TIMEOUT', message: 'x' })).toBe(
    'This turn stopped because it ran past its time limit.',
  )
  expect(noticeText({ code: 'EH_RUN_FAILED', message: 'x' })).toBe(
    'Unexpected error (see server logs).',
  )
})

test('unknown notices (and ones the core already wrote) stay as they are', () => {
  expect(noticeText({ code: 'EH_COST_CAP', message: 'Budget exhausted.' })).toBe(
    'Budget exhausted.',
  )
  expect(noticeText({ message: 'Sesuatu' })).toBe('Sesuatu')
  const messages = [
    {
      id: 'n',
      role: 'assistant',
      parts: [
        {
          type: 'data-eh.notice',
          data: {
            level: 'warning',
            code: 'EH_TURN_INTERRUPTED',
            message: 'The previous turn was interrupted: its process stopped before it finished.',
          },
        },
      ],
    },
  ] as UIMessage[]
  expect(toItems(messages)[0]).toMatchObject({
    kind: 'notice',
    level: 'warning',
    text: 'The previous turn was interrupted: its process stopped before it finished.',
  })
})

test('notice code table: every eharness code is mapped, generic, or never stored as a notice', async () => {
  const { NOTICE_CODES } = await import('@keith/client')
  const { GENERIC_NOTICE_CODES, NOTICE_BY_CODE } = await import('./message-text.ts')
  // thrown to the app, never stored as an eh.notice: no row to render
  const thrownOnly = [
    'EH_CONFIG_INVALID',
    'EH_MCP_TIMEOUT',
    'EH_DUPLICATE_TOOL',
    'EH_DUPLICATE_SKILL',
    'EH_DUPLICATE_DATA_PART',
    'EH_SERVICE_CONFLICT',
    'EH_SERVICE_MISSING',
    'EH_PLUGIN_ORDER',
    'EH_SESSION_BUSY',
    'EH_SESSION_CLOSED',
    'EH_INVALID_INPUT',
    'EH_PENDING_RESPONSE',
    'EH_INVALID_MESSAGE',
    'EH_EVENTS_OVERFLOW',
  ]
  const mapped = Object.keys(NOTICE_BY_CODE)
  const known = new Set<string>([...mapped, ...GENERIC_NOTICE_CODES, ...thrownOnly])
  // a code that eharness adds fails here until someone decides how the TUI shows it
  expect(Object.values(NOTICE_CODES).filter((c) => !known.has(c))).toEqual([])
  // no stale entry for a code eharness dropped
  expect([...known].filter((c) => !(c in NOTICE_CODES))).toEqual([])
  for (const code of mapped) {
    expect(noticeText({ code, message: 'stored' })).toBe(
      NOTICE_BY_CODE[code as keyof typeof NOTICE_BY_CODE] as string,
    )
  }
  for (const code of GENERIC_NOTICE_CODES)
    expect(noticeText({ code, message: 'stored' })).toBe('stored')
})

test('a message stopped with the aborted stop reason ends with the stopped mark', () => {
  const messages = [
    {
      id: 'a',
      role: 'assistant',
      metadata: { eharness: { stop: 'aborted' } },
      parts: [{ type: 'text', text: 'partial' }],
    },
  ] as UIMessage[]
  expect(toItems(messages)[0]).toMatchObject({ kind: 'assistant', stopped: true })
})

test('a protocol question is a question item with its run and options; other events are not', () => {
  const messages = [
    {
      id: 'q1',
      role: 'user',
      parts: [
        {
          type: 'data-eh.event',
          data: {
            name: 'protocol.ask',
            text: 'Water the plants today?',
            data: { runId: 'run-7', step: 'ask-water', options: ['yes', 'later'] },
          },
        },
      ],
    },
    {
      id: 'e1',
      role: 'user',
      parts: [{ type: 'data-eh.event', data: { name: 'delivery.failed', text: 'x' } }],
    },
  ] as UIMessage[]
  expect(toItems(messages)).toEqual([
    {
      id: 'q1:question:0',
      kind: 'question',
      runId: 'run-7',
      text: 'Water the plants today?',
      options: ['yes', 'later'],
    },
  ])
  expect(
    questionOf({ type: 'data-eh.event', data: { name: 'protocol.ask', text: 'x' } }),
  ).toBeUndefined()
})

describe('the dreaming notice', () => {
  test('a dreaming.notice event part shows as an info notice with its text; other events do not', () => {
    const notice = 'Memory review ready: 3 new notes checked. Run /dream apply to write them.'
    const items = toItems([
      {
        id: 'd1',
        role: 'assistant',
        parts: [
          { type: 'data-eh.event', data: { name: 'dreaming.notice', text: notice } },
          { type: 'data-eh.event', data: { name: 'something.else', text: 'no' } },
        ],
      } as unknown as UIMessage,
    ])
    expect(items).toEqual([{ id: 'd1:dream:0', kind: 'notice', level: 'info', text: notice }])
  })
})

describe('the compaction marker', () => {
  test('a stored eh.compaction shows as a divider "conversation compacted", in order', () => {
    const items = toItems([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage,
      {
        id: 'c1',
        role: 'user',
        parts: [{ type: 'data-eh.compaction', data: {} }],
        metadata: { eharness: { kind: 'eh.compaction' } },
      } as unknown as UIMessage,
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'divider'])
    expect(items[1]).toEqual({ id: 'c1:compacted:0', kind: 'divider', text: COMPACTED_TEXT })
  })
})
