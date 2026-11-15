import { describe, expect, test } from 'bun:test'
import type { AttentionItem } from '@keith/client/browser'
import {
  answerFailure,
  cardKeyAction,
  cardOf,
  countdownText,
  inboxBadge,
  isStepUpCancelled,
  isTypingTarget,
  type KeyContext,
  newlyExpired,
} from './card.ts'

const NOW = 1_000_000_000

const shell = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    kind: 'approval',
    id: 'a1',
    sessionId: 's1',
    toolName: 'motor_remote',
    agent: 'cortex.research',
    name: 'research',
    description: 'check disk space',
    createdAt: NOW - 5 * 60_000,
    input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'df -h' } },
    extra: { scopable: true, expiresAt: NOW + 5 * 3_600_000 },
    ...over,
  }) as unknown as AttentionItem

describe('cardOf', () => {
  test('shell approval: full command, node, tool, age and countdown', () => {
    const v = cardOf(shell(), NOW)
    expect(v.headline).toBe('research wants to run a shell command on laptop-e')
    expect(v.command).toBe('df -h')
    expect(v.node).toBe('laptop-e')
    expect(v.tool).toBe('shell.exec')
    expect(v.age).toBe('asked 5 min ago')
    expect(v.expiry).toBe('expires in 5 h 00 min')
    expect(v.scopable).toBe(true)
    expect(v.waiting).toBe(false)
    expect(v.warn).toBe(false)
  })

  test('a long command is shown whole', () => {
    const command = `echo ${'x'.repeat(500)}`
    const v = cardOf(
      shell({ input: { node: 'n', capability: 'shell.exec', input: { command } } } as never),
      NOW,
    )
    expect(v.command).toBe(command)
  })

  test('desktop.input actions in words', () => {
    const v = cardOf(
      shell({
        input: {
          node: 'mac',
          capability: 'desktop.input',
          input: {
            actions: [
              { type: 'click', x: 412, y: 230 },
              { type: 'type', text: 'hi' },
            ],
          },
        },
      } as never),
      NOW,
    )
    expect(v.actions).toEqual(['click (412, 230)', 'type "hi"'])
    expect(v.command).toBeUndefined()
    expect(v.tool).toBe('desktop.input')
  })

  test('a plain tool shows its name and JSON input', () => {
    const v = cardOf(shell({ toolName: 'web_fetch', input: { a: 1 }, extra: {} } as never), NOW)
    expect(v.tool).toBe('web_fetch')
    expect(v.headline).toBe('research wants to call web_fetch')
    expect(v.detail).toBe('{"a":1}')
    expect(v.expiry).toBeUndefined()
    expect(v.scopable).toBe(false)
  })

  test('soon and expired turn the age line amber', () => {
    expect(cardOf(shell({ extra: { expiresAt: NOW + 60 * 60_000 } } as never), NOW).warn).toBe(true)
    const gone = cardOf(shell({ extra: { expiresAt: NOW - 1 } } as never), NOW)
    expect(gone.warn).toBe(true)
    expect(gone.expired).toBe(true)
    expect(gone.expiry).toBe('expired')
  })

  test('a member request waiting for the owner is marked', () => {
    expect(cardOf(shell({ extra: { waitingFor: 'owner' } } as never), NOW).waiting).toBe(true)
  })

  test('an owner view of a member request names the asker', () => {
    const v = cardOf(
      shell({ extra: { askedBy: 'ana', askedByName: 'Ana', command: 'ls', node: 'n1' } } as never),
      NOW,
    )
    expect(v.headline).toBe('Ana asks to run a shell command on n1')
  })
})

describe('countdownText', () => {
  test('minutes and seconds under an hour', () => {
    expect(countdownText(NOW + 5_000, NOW)).toBe('expires in 0:05')
    expect(countdownText(NOW + 59 * 60_000, NOW)).toBe('expires in 59:00')
  })
  test('hours and minutes above', () => {
    expect(countdownText(NOW + 3 * 3_600_000 + 5 * 60_000, NOW)).toBe('expires in 3 h 05 min')
  })
  test('expired at and past the time', () => {
    expect(countdownText(NOW, NOW)).toBe('expired')
    expect(countdownText(NOW - 10, NOW)).toBe('expired')
  })
})

describe('cardKeyAction', () => {
  const ctx: KeyContext = { cardFocused: true, typing: false, scopable: true, readOnly: false }
  test('y n N a when the card itself has focus', () => {
    expect(cardKeyAction({ key: 'y' }, ctx)).toBe('allow')
    expect(cardKeyAction({ key: 'n' }, ctx)).toBe('deny')
    expect(cardKeyAction({ key: 'N' }, ctx)).toBe('deny-reason')
    expect(cardKeyAction({ key: 'a' }, ctx)).toBe('allow-task')
    expect(cardKeyAction({ key: 'x' }, ctx)).toBe('none')
  })
  test('no key answers while a text field has focus (the composer, the reason field)', () => {
    for (const key of ['y', 'n', 'N', 'a'])
      expect(cardKeyAction({ key }, { ...ctx, typing: true })).toBe('none')
  })
  test('no key answers when the card is not the focused element', () => {
    expect(cardKeyAction({ key: 'y' }, { ...ctx, cardFocused: false })).toBe('none')
  })
  test('a is ignored when the request is not scopable', () => {
    expect(cardKeyAction({ key: 'a' }, { ...ctx, scopable: false })).toBe('none')
  })
  test('modifiers and read only cards answer nothing', () => {
    expect(cardKeyAction({ key: 'y', metaKey: true }, ctx)).toBe('none')
    expect(cardKeyAction({ key: 'y', ctrlKey: true }, ctx)).toBe('none')
    expect(cardKeyAction({ key: 'y' }, { ...ctx, readOnly: true })).toBe('none')
  })
})

describe('isTypingTarget', () => {
  test('inputs, textareas, selects and editable content type', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('inboxBadge', () => {
  test('nothing at zero, the count, 99+', () => {
    expect(inboxBadge(0)).toBeUndefined()
    expect(inboxBadge(3)).toBe('3')
    expect(inboxBadge(100)).toBe('99+')
  })
})

describe('newlyExpired', () => {
  test('reports an expired approval once', () => {
    const seen = new Set<string>()
    const gone = shell({ id: 'x', extra: { expiresAt: NOW - 1 } } as never)
    const live = shell({ id: 'y' })
    expect(newlyExpired([gone, live], NOW, seen)).toEqual(['x'])
    expect(newlyExpired([gone, live], NOW, seen)).toEqual([])
  })
})

describe('isStepUpCancelled', () => {
  test('a dismissed step-up is not a failure', () => {
    expect(
      isStepUpCancelled(Object.assign(new Error('Not confirmed.'), { name: 'StepUpCancelled' })),
    ).toBe(true)
    expect(isStepUpCancelled(new Error('boom'))).toBe(false)
  })
})

describe('answerFailure', () => {
  test('the TUI texts', () => {
    expect(answerFailure(Object.assign(new Error('x'), { code: 'KEITH_WAITING_FOR_OWNER' }))).toBe(
      'Waiting for the owner to approve',
    )
    expect(answerFailure(new Error('boom'))).toBe('Failed to answer: boom')
  })
})
