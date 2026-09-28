import { describe, expect, test } from 'bun:test'
import type { LlmMessage } from '@keith/sdk'
import type { PersonId } from '../shared/types.ts'
import type { MessageRecord } from '../storage/types.ts'
import { authorName, toLlmMessages, UNKNOWN_AUTHOR } from './messages.ts'
import { PEPPER, TONY } from './testing/harness.ts'

const THREAD = 'thr_00000000000000000000000001' as const
const GONE: PersonId = 'per_0000000000000000000000G0NE'
const NAMES = new Map<PersonId, string>([
  [TONY, 'Tony'],
  [PEPPER, 'Pepper'],
])

let seq = 0
function base(content: string) {
  seq++
  return {
    id: `msg_${String(seq).padStart(26, '0')}` as const,
    threadId: THREAD,
    nodeId: null,
    modality: 'text' as const,
    content,
    meta: null,
    createdAt: seq,
  }
}

function user(content: string, author: PersonId | null = TONY): MessageRecord {
  return { ...base(content), role: 'user', authorPersonId: author }
}

function assistant(content: string, toolCallIds: string[] = []): MessageRecord {
  return {
    ...base(content),
    role: 'assistant',
    authorPersonId: null,
    toolCalls: toolCallIds.length > 0 ? toolCallIds.map((id) => ({ id, name: 'test.echo', args: {} })) : null,
    ui: null,
  }
}

function tool(toolCallId: string, content: string): MessageRecord {
  return {
    ...base(content),
    role: 'tool',
    authorPersonId: null,
    toolCallId,
    toolName: 'test.echo',
    isError: false,
  }
}

describe('toLlmMessages: author names in group threads (D7)', () => {
  test('in a group, a user row gets name and a name prefix', () => {
    expect(toLlmMessages([user('Keith, book the jet.', PEPPER)], { group: true, names: NAMES })).toEqual([
      { role: 'user', name: 'Pepper', content: 'Pepper: Keith, book the jet.' },
    ])
  })

  test('in a direct thread nothing changes, names or not', () => {
    const records = [user('hello'), assistant('Good morning, sir.')]
    const plain: LlmMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Good morning, sir.' },
    ]
    expect(toLlmMessages(records)).toEqual(plain)
    expect(toLlmMessages(records, { names: NAMES })).toEqual(plain)
    expect(toLlmMessages(records, { group: false, names: NAMES })).toEqual(plain)
  })

  test('an unknown or missing author reads as Someone', () => {
    expect(toLlmMessages([user('hi', GONE), user('hey', null)], { group: true, names: NAMES })).toEqual([
      { role: 'user', name: 'Someone', content: 'Someone: hi' },
      { role: 'user', name: 'Someone', content: 'Someone: hey' },
    ])
    expect(toLlmMessages([user('hi')], { group: true })).toEqual([
      { role: 'user', name: UNKNOWN_AUTHOR, content: 'Someone: hi' },
    ])
  })

  test('the replay rules still hold in a group', () => {
    const records = [
      tool('lost', 'cut off by the window'),
      user('Keith, check the suit.'),
      assistant('', ['c1']),
      tool('c1', 'result'),
      assistant('Suit is ready.'),
      user('Thanks, Keith.', PEPPER),
      assistant('Let me check', ['c2']),
    ]
    expect(toLlmMessages(records, { group: true, names: NAMES })).toEqual([
      { role: 'user', name: 'Tony', content: 'Tony: Keith, check the suit.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'test.echo', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'result' },
      { role: 'assistant', content: 'Suit is ready.' },
      { role: 'user', name: 'Pepper', content: 'Pepper: Thanks, Keith.' },
      { role: 'assistant', content: 'Let me check' },
    ])
  })

  test('authorName', () => {
    expect(authorName(TONY, NAMES)).toBe('Tony')
    expect(authorName(GONE, NAMES)).toBe('Someone')
    expect(authorName(null, NAMES)).toBe('Someone')
    expect(authorName(TONY)).toBe('Someone')
  })
})
