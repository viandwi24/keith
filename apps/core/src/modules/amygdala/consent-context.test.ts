// Clean or tainted from the restricted transcript (ADR-0036 §2): the table of transcripts the decision must get right.
import { describe, expect, test } from 'bun:test'
import type { ToolSource } from '@keith/contracts'
import type { GuardTranscriptEntry } from 'eharness'
import { type ConsentOrigin, consentContext } from './consent-context.ts'

const user = (text = 'switch to butler'): GuardTranscriptEntry => ({ role: 'user', text })
const call = (toolName: string): GuardTranscriptEntry => ({
  role: 'tool-call',
  toolName,
  input: {},
})
const SOURCES: Record<string, ToolSource> = {
  persona_get: 'trusted',
  presence: 'trusted',
  web_fetch: 'outside',
  agent: 'outside',
  motor_remote: 'outside',
}
const sourceOf = (name: string): ToolSource => SOURCES[name] ?? 'outside'

const cases: Array<[string, ConsentOrigin, GuardTranscriptEntry[], 'clean' | 'tainted']> = [
  ['the person asked and nothing ran', 'person', [user()], 'clean'],
  [
    'trusted reads after the person message',
    'person',
    [user(), call('persona_get'), call('presence')],
    'clean',
  ],
  ['a web_fetch after the person message', 'person', [user(), call('web_fetch')], 'tainted'],
  [
    'a trusted read, then a web_fetch',
    'person',
    [user(), call('persona_get'), call('web_fetch')],
    'tainted',
  ],
  ['an agent delegation and its report', 'person', [user(), call('agent')], 'tainted'],
  [
    'a new person message after outside content makes it clean again',
    'person',
    [user('look this up'), call('web_fetch'), user('now switch to butler')],
    'clean',
  ],
  [
    'outside content before the newest person message does not count',
    'person',
    [user(), call('agent'), call('web_fetch'), user('ok do it'), call('persona_get')],
    'clean',
  ],
  ['an undeclared tool is outside', 'person', [user(), call('some_new_tool')], 'tainted'],
  ['a turn with no person message in view', 'person', [call('persona_get')], 'tainted'],
  ['an empty transcript on a person turn', 'person', [], 'tainted'],
  [
    'a wake turn (protocol, plugin, reminder, report, room, digest) is tainted even after a person message',
    'tainted',
    [user()],
    'tainted',
  ],
  ['a wake turn with no entries', 'tainted', [], 'tainted'],
  [
    'a worker delegated cleanly with only trusted calls',
    'delegated-clean',
    [call('persona_get')],
    'clean',
  ],
  ['a worker delegated cleanly with no calls yet', 'delegated-clean', [], 'clean'],
  [
    'a worker delegated cleanly that read a page',
    'delegated-clean',
    [call('web_fetch')],
    'tainted',
  ],
  [
    'a worker delegated cleanly that ran a shell command',
    'delegated-clean',
    [call('motor_remote')],
    'tainted',
  ],
  [
    'a worker whose prompt shows as a message, then trusted calls',
    'delegated-clean',
    [user('task'), call('persona_get')],
    'clean',
  ],
  [
    'a worker whose prompt shows as a message, then a page',
    'delegated-clean',
    [user('task'), call('web_fetch')],
    'tainted',
  ],
  ['a worker delegated from a tainted call', 'tainted', [call('persona_get')], 'tainted'],
]

describe('consentContext', () => {
  test.each(cases)('%s', (_name, origin, transcript, expected) => {
    expect(consentContext({ transcript, sourceOf, origin })).toBe(expected)
  })

  test('a person turn ignores the order of earlier outside calls only when a newer person message follows them', () => {
    const transcript = [user('a'), call('web_fetch'), user('b'), call('web_fetch')]
    expect(consentContext({ transcript, sourceOf, origin: 'person' })).toBe('tainted')
  })
})
