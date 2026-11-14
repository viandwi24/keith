import { describe, expect, test } from 'bun:test'
import { UsageError } from '@keith/cli'
import { keithContract } from '@keith/contracts'
import { authorize } from '../platform/rpc.ts'
import { noticeInput, noticeLines } from './notify-command.ts'

describe('keith-core notify: the command line', () => {
  test('the first word is the username, the rest is the text, joined with single spaces', () => {
    expect(noticeInput(['ana', 'hello', 'from', 'step', '6'])).toEqual({
      person: 'ana',
      text: 'hello from step 6',
    })
  })

  test('a missing username or a missing text is a usage error', () => {
    expect(() => noticeInput([])).toThrow(UsageError)
    expect(() => noticeInput(['ana'])).toThrow('missing text')
    expect(() => noticeInput(['ana', '   '])).toThrow('missing text')
  })

  test('a text longer than the notice limit is refused before the core is called', () => {
    expect(() => noticeInput(['ana', 'x'.repeat(501)])).toThrow('longer than 500 characters')
    expect(noticeInput(['ana', 'x'.repeat(500)]).text).toHaveLength(500)
  })
})

describe('keith-core notify: the outcome line', () => {
  test('a client that declared notify shows the client id', () => {
    expect(
      noticeLines(
        {
          id: 'notice:1',
          to: 'ana',
          outcome: { status: 'delivered', route: 'client:0190-desk', attempts: 1 },
        },
        'ana',
      ),
    ).toEqual(['delivered to ana on client 0190-desk (toast)'])
  })

  test('no client takes it: the front session got it as a note', () => {
    expect(
      noticeLines(
        {
          id: 'notice:2',
          to: 'ana',
          outcome: { status: 'delivered', route: 'front', attempts: 1 },
        },
        'ana',
      ),
    ).toEqual(['delivered to ana on the front session (no client took it; stored as a note)'])
  })

  test('a queued or failed outcome says why', () => {
    const queued = noticeLines(
      {
        id: 'notice:3',
        to: 'ana',
        outcome: {
          status: 'queued',
          reason: 'unavailable',
          nextAttemptAt: Date.UTC(2026, 10, 14, 9, 30),
        },
      },
      'ana',
    )
    expect(queued).toEqual(['queued for ana: no route now, the core retries at 2026-11-14 09:30'])
    expect(
      noticeLines(
        {
          id: 'notice:4',
          to: 'ana',
          outcome: { status: 'failed', reason: 'recipient-gone', attempts: 1 },
        },
        'ana',
      ),
    ).toEqual(['not delivered to ana: recipient-gone'])
  })
})

describe('admin.notice.send: who may call it', () => {
  const meta = (keithContract.admin.notice.send as unknown as { '~orpc': { meta: object } })[
    '~orpc'
  ].meta as Parameters<typeof authorize>[0]

  test('the owner capability with a step-up, the same as the presence read', () => {
    expect(meta).toEqual({ capability: 'audit.read', stepUp: true })
  })

  test('a caller without audit.read is refused (FORBIDDEN)', () => {
    expect(() =>
      authorize(meta, {
        principal: {} as never,
        via: 'local',
        capabilities: new Set(['chat', 'audit.mine']),
      }),
    ).toThrow('you do not have the audit.read capability')
  })
})
