import { expect, test } from 'bun:test'
import type { AttentionItem } from '@keith/client/browser'
import { actionOf } from './approval-headline.ts'
import { askOf } from './approval-state.ts'
import {
  consentOf,
  expiresIn,
  groupApprovals,
  isConversation,
  newInboxIds,
  offersTaskGrant,
  quietLineOf,
  routeOf,
  summaryOf,
} from './consent-state.ts'

const NOW = 1_000_000

const item = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'a',
    kind: 'approval',
    sessionId: 's',
    parentSessionId: null,
    rootSessionId: 's',
    toolCallId: 'c',
    toolName: 'persona_template',
    agent: 'front',
    input: { template: 'butler' },
    risk: 'write',
    messageId: 'm',
    createdAt: NOW - 1000,
    answeredWaiting: 0,
    extra: { consent: 'conversation', scopable: true, expiresAt: NOW + 272_000 },
    ...over,
  }) as AttentionItem

const shell = (over: Partial<AttentionItem> = {}): AttentionItem =>
  item({
    id: 'sh',
    toolName: 'motor_remote',
    agent: 'cortex.general',
    input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
    extra: { consent: 'device', scopable: true },
    ...over,
  })

test('classification: conversation, device, other (a member asks the owner) and legacy (no field)', () => {
  expect(routeOf(item())).toBe('conversation')
  expect(routeOf(shell())).toBe('device')
  expect(routeOf(shell({ extra: { consent: 'device', askedBy: 'ana' } }))).toBe('other')
  expect(routeOf(item({ extra: { consent: 'conversation', askedBy: 'ana' } }))).toBe('other')
  expect(routeOf(shell({ extra: { scopable: true } }))).toBe('legacy')
  expect(routeOf(shell({ extra: {} }))).toBe('legacy')
  expect(consentOf(item({ extra: { consent: 'weird' } }))).toBeUndefined()
  expect(isConversation(item())).toBe(true)
  expect(isConversation(shell())).toBe(false)
})

test('groupApprovals keeps the order inside each group', () => {
  const groups = groupApprovals([
    shell({ id: 'd1' }),
    item({ id: 'c1' }),
    shell({ id: 'l1', extra: {} }),
    item({ id: 'c2' }),
  ])
  expect(groups.conversation.map((i) => i.id)).toEqual(['c1', 'c2'])
  expect(groups.inbox.map((i) => i.id)).toEqual(['d1'])
  expect(groups.legacy.map((i) => i.id)).toEqual(['l1'])
})

test('headlines: a human line per tool, the generic line for the rest', () => {
  const ask = (toolName: string, input: unknown, agent = 'front') =>
    askOf(item({ toolName, input, agent })).headline
  expect(ask('persona_template', { template: 'butler' })).toBe(
    'keith wants to switch the persona to butler',
  )
  expect(ask('persona_edit', { tone: 'Loud' })).toBe('keith wants to edit the persona')
  expect(ask('persona_restore', { version: 3 })).toBe('keith wants to restore persona version 3')
  expect(ask('model_role_set', { role: 'front', model: 'openrouter:x/y' })).toBe(
    'keith wants to use openrouter:x/y for the front role',
  )
  expect(ask('style_set', { tone: 'warm' })).toBe('keith wants to change how Keith talks to you')
  expect(ask('presence_status_set', { status: 'busy' })).toBe('keith wants to set your status')
  expect(ask('undo_last', {})).toBe('keith wants to undo the last change')
  expect(ask('web_fetch', { url: 'https://x.test' })).toBe('keith wants to call web_fetch')
  expect(askOf(item({ toolName: 'persona_edit', input: { tone: 'Loud' } })).detail).toBeUndefined()
  expect(askOf(item({ toolName: 'web_fetch', input: { url: 'u' } })).detail).toBe('{"url":"u"}')
  expect(actionOf('motor_remote', shell().input)).toBe('run `df -h` on laptop-e')
  // the existing shell headline is unchanged
  expect(askOf(shell()).headline).toBe('general wants to run a shell command on laptop-e')
})

test('"Allow for task" is hidden for persona, model, style, status tools and every conversation request', () => {
  expect(offersTaskGrant(shell())).toBe(true)
  expect(offersTaskGrant(shell({ extra: { scopable: true } }))).toBe(true) // legacy unchanged
  expect(offersTaskGrant(shell({ extra: { consent: 'conversation', scopable: true } }))).toBe(false)
  for (const tool of [
    'persona_template',
    'persona_edit',
    'persona_restore',
    'model_role_set',
    'style_set',
    'presence_status_set',
  ])
    expect(
      offersTaskGrant(item({ toolName: tool, extra: { consent: 'device', scopable: true } })),
    ).toBe(false)
  expect(offersTaskGrant(shell({ extra: { consent: 'device', scopable: false } }))).toBe(false)
})

test('the quiet line: conversation wins and shows the summary and the countdown', () => {
  const line = quietLineOf([shell(), item()], NOW)
  expect(line?.kind).toBe('conversation')
  expect(line?.text).toBe(
    'Keith is waiting for your yes or no · switch the persona to butler · expires in 4:32',
  )
  expect(line?.itemId).toBe('a')
})

test('the quiet line: device and other requests say where to confirm; a client can name the key', () => {
  expect(quietLineOf([shell()], NOW)?.text).toBe('Confirm in the Inbox · run `df -h` on laptop-e')
  expect(quietLineOf([shell()], NOW, '/inbox')?.text).toBe(
    'Confirm in the Inbox (/inbox) · run `df -h` on laptop-e',
  )
  const asked = shell({ extra: { consent: 'device', askedBy: 'ana', askedByName: 'Ana' } })
  expect(quietLineOf([asked], NOW)?.summary).toBe('Ana asks to run `df -h` on laptop-e')
  const waiting = shell({ extra: { consent: 'device', waitingFor: 'owner' } })
  expect(quietLineOf([waiting], NOW)?.text).toStartWith('Waiting for the owner to approve')
})

test('the quiet line: nothing for legacy items or an empty list; expired is said', () => {
  expect(quietLineOf([], NOW)).toBeUndefined()
  expect(quietLineOf([shell({ extra: { scopable: true } })], NOW)).toBeUndefined()
  expect(
    quietLineOf([item({ extra: { consent: 'conversation', expiresAt: NOW - 1 } })], NOW)?.expiry,
  ).toBe('expired')
  expect(expiresIn(NOW + 3 * 3_600_000 + 5 * 60_000, NOW)).toBe('expires in 3 h 05 min')
})

test('summaryOf clips a long command', () => {
  const long = shell({
    input: { node: 'n', capability: 'shell.exec', input: { command: 'x'.repeat(200) } },
  })
  expect(summaryOf(long).length).toBeLessThanOrEqual(80)
})

test('newInboxIds announces each device or other request once, never conversation, legacy or owner waits', () => {
  const seen = new Set<string>()
  const items = [
    shell({ id: 'd1' }),
    item({ id: 'c1' }),
    shell({ id: 'l1', extra: {} }),
    shell({ id: 'w1', extra: { consent: 'device', waitingFor: 'owner' } }),
  ]
  expect(newInboxIds(items, seen)).toEqual(['d1'])
  expect(newInboxIds(items, seen)).toEqual([])
})
