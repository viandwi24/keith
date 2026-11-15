import { describe, expect, test } from 'bun:test'
import type { AttentionItem } from '@keith/client/browser'
import { cardOf } from './card.ts'
import { cardAnchor, inboxToast, lineView } from './consent-line.ts'

const NOW = 1_000_000_000

const item = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    kind: 'approval',
    id: 'a1',
    sessionId: 's1',
    toolName: 'persona_template',
    agent: 'front',
    input: { template: 'butler' },
    createdAt: NOW - 1000,
    extra: { consent: 'conversation', scopable: true, expiresAt: NOW + 272_000 },
    ...over,
  }) as unknown as AttentionItem

describe('lineView', () => {
  test('a conversation request: the quiet line with a details link to its Inbox card', () => {
    const v = lineView([item()], NOW, '/app')
    expect(v?.text).toBe(
      'Keith is waiting for your yes or no · switch the persona to butler · expires in 4:32',
    )
    expect(v?.kind).toBe('conversation')
    expect(v?.linkLabel).toBe('details')
    expect(v?.href).toBe(`/app/inbox#${cardAnchor('a1')}`)
  })

  test('a device request says to confirm in the Inbox', () => {
    const v = lineView(
      [
        item({
          toolName: 'model_role_set',
          input: { role: 'front', model: 'openrouter:x' },
          extra: { consent: 'device' },
        }),
      ],
      NOW,
      '',
    )
    expect(v?.text).toBe('Confirm in the Inbox · use openrouter:x for the front role')
    expect(v?.href).toBe('/inbox#approval-a1')
  })

  test('no line for an old core (card in the chat) or an empty list', () => {
    expect(lineView([item({ extra: { scopable: true } })], NOW, '')).toBeUndefined()
    expect(lineView([], NOW, '')).toBeUndefined()
  })

  test('the toast links to the Inbox', () => {
    expect(inboxToast('/app')).toEqual({
      text: 'Confirm in the Inbox',
      link: { href: '/app/inbox', label: 'Open the Inbox' },
    })
  })
})

describe('cardOf for consent', () => {
  test('a conversation card has the human headline, no "Allow for task", no key shortcuts flag', () => {
    const v = cardOf(item(), NOW)
    expect(v.headline).toBe('keith wants to switch the persona to butler')
    expect(v.detail).toBeUndefined()
    expect(v.scopable).toBe(false)
    expect(v.conversation).toBe(true)
  })

  test('a device card for a persona tool hides "Allow for task"; a shell one keeps it', () => {
    expect(cardOf(item({ extra: { consent: 'device', scopable: true } }), NOW).scopable).toBe(false)
    const shell = item({
      toolName: 'motor_remote',
      input: { node: 'n', capability: 'shell.exec', input: { command: 'ls' } },
      extra: { consent: 'device', scopable: true },
    })
    expect(cardOf(shell, NOW).scopable).toBe(true)
    expect(cardOf(shell, NOW).conversation).toBe(false)
  })
})
