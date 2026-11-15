import { describe, expect, test } from 'bun:test'
import { ChatContextDeadlineError } from '@keith/client/browser'
import type { ChatContextRefusalReason } from '@keith/contracts'
import {
  COMPACT_FLUSH_FAILED_TEXT,
  COMPACT_USAGE,
  CONTEXT_DEADLINE_TEXT,
  CONTEXT_REFUSAL_TEXT,
  type ContextCommandEnv,
  compactDoneText,
  NEW_USAGE,
  newContextDoneText,
  parseContextCommand,
  runContextCommand,
  showsDivider,
} from './context-commands.ts'

describe('parseContextCommand', () => {
  test('/new flushes first; --no-flush turns the flush off; anything else is the usage line', () => {
    expect(parseContextCommand('new', '')).toEqual({ kind: 'new', flush: true })
    expect(parseContextCommand('new', '   ')).toEqual({ kind: 'new', flush: true })
    expect(parseContextCommand('new', '--no-flush')).toEqual({ kind: 'new', flush: false })
    expect(parseContextCommand('new', ' --no-flush ')).toEqual({ kind: 'new', flush: false })
    expect(parseContextCommand('new', '--flush')).toEqual({ kind: 'usage', text: NEW_USAGE })
    expect(parseContextCommand('new', '--no-flush now')).toEqual({ kind: 'usage', text: NEW_USAGE })
  })

  test('/compact takes no argument', () => {
    expect(parseContextCommand('compact', '')).toEqual({ kind: 'compact' })
    expect(parseContextCommand('compact', 'hard')).toEqual({ kind: 'usage', text: COMPACT_USAGE })
  })
})

describe('the toast texts', () => {
  test('each refusal reason has its plain words', () => {
    expect(CONTEXT_REFUSAL_TEXT).toEqual({
      'turn-running': 'a turn is still running',
      'approval-pending': 'an approval is waiting',
      'task-running': 'a task is still running',
      'flush-failed':
        'Could not save to memory, so nothing was changed. Try /new again later, or /new --no-flush to start fresh without saving.',
    } satisfies Record<ChatContextRefusalReason, string>)
  })

  test('the reset says what is kept and what is cleared; --no-flush says nothing was saved', () => {
    expect(newContextDoneText(true)).toBe(
      "New context started. Memory, persona and style are kept; this conversation's context is cleared.",
    )
    expect(newContextDoneText(false)).toContain('Nothing was saved to memory first.')
    expect(compactDoneText(true)).toContain('Memory, persona and style are kept')
    expect(compactDoneText(true)).not.toContain('Nothing was saved')
  })

  test('the divider shows only from the second generation on', () => {
    expect(showsDivider(0)).toBe(false)
    expect(showsDivider(1)).toBe(true)
    expect(showsDivider(3)).toBe(true)
  })
})

/** A fake client whose calls settle with the given outcome; the toasts and notices are recorded. */
function fakeEnv(outcome: { ok: true; flushed: boolean } | { ok: false; error: unknown }) {
  const calls: Array<{ name: string; input: unknown }> = []
  const toasts: Array<[string, string]> = []
  const said: string[][] = []
  const settle = () =>
    outcome.ok
      ? Promise.resolve({ generation: 1, flushed: outcome.flushed })
      : Promise.reject(outcome.error)
  const env: ContextCommandEnv = {
    chatContext: {
      newContext: (input) => {
        calls.push({ name: 'newContext', input })
        return settle()
      },
      compact: () => {
        calls.push({ name: 'compact', input: undefined })
        return settle()
      },
    },
    toast: (text, level) => toasts.push([text, level]),
    say: (_level, rows) => said.push([...rows]),
  }
  return { env, calls, toasts, said }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const refusal = (reason: string) => ({ code: 'CONFLICT', message: 'refused', data: { reason } })

describe('runContextCommand', () => {
  test('/new calls newContext with the flag and toasts the success', async () => {
    const { env, calls, toasts } = fakeEnv({ ok: true, flushed: true })
    runContextCommand({ kind: 'new', flush: true }, env)
    await tick()
    expect(calls).toEqual([{ name: 'newContext', input: { flush: true } }])
    expect(toasts).toEqual([[newContextDoneText(true), 'success']])
  })

  test('/new --no-flush calls newContext with flush false', async () => {
    const { env, calls, toasts } = fakeEnv({ ok: true, flushed: false })
    runContextCommand({ kind: 'new', flush: false }, env)
    await tick()
    expect(calls).toEqual([{ name: 'newContext', input: { flush: false } }])
    expect(toasts).toEqual([[newContextDoneText(false), 'success']])
  })

  test('/compact calls compact and toasts the success', async () => {
    const { env, calls, toasts } = fakeEnv({ ok: true, flushed: true })
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(calls.map((c) => c.name)).toEqual(['compact'])
    expect(toasts).toEqual([[compactDoneText(true), 'success']])
  })

  test('/compact whose flush did not save says so in the success toast', async () => {
    const { env, toasts } = fakeEnv({ ok: true, flushed: false })
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(toasts).toEqual([[compactDoneText(false), 'success']])
    expect(toasts[0]?.[0]).toContain('Nothing was saved to memory first.')
    expect(toasts[0]?.[0]).toContain('Memory, persona and style are kept')
  })

  test('each refusal reason is a warning toast with its words', async () => {
    const reasons: ChatContextRefusalReason[] = [
      'turn-running',
      'approval-pending',
      'task-running',
      'flush-failed',
    ]
    for (const reason of reasons) {
      const { env, toasts } = fakeEnv({ ok: false, error: refusal(reason) })
      runContextCommand({ kind: 'new', flush: true }, env)
      await tick()
      expect(toasts).toEqual([[CONTEXT_REFUSAL_TEXT[reason], 'warning']])
    }
  })

  test('/compact refused by a failed or skipped flush says nothing was compacted', async () => {
    const { env, toasts } = fakeEnv({ ok: false, error: refusal('flush-failed') })
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(toasts).toEqual([[COMPACT_FLUSH_FAILED_TEXT, 'warning']])
    expect(COMPACT_FLUSH_FAILED_TEXT).toBe(
      'Could not save to memory, so nothing was compacted. Try again later.',
    )
  })

  test('/compact keeps the other refusal words', async () => {
    const { env, toasts } = fakeEnv({ ok: false, error: refusal('turn-running') })
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(toasts).toEqual([[CONTEXT_REFUSAL_TEXT['turn-running'], 'warning']])
  })

  test('any other error is an error toast with its message', async () => {
    const { env, toasts } = fakeEnv({ ok: false, error: new Error('the core is down') })
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(toasts).toEqual([['the core is down', 'error']])
  })

  test('the change is marked pending from the call until it settles, a refusal included', async () => {
    const marks: string[] = []
    for (const outcome of [
      { ok: true, flushed: true } as const,
      { ok: false, error: refusal('turn-running') } as const,
    ]) {
      const { env } = fakeEnv(outcome)
      marks.length = 0
      runContextCommand(
        { kind: 'new', flush: true },
        {
          ...env,
          pending: {
            begin: (kind) => marks.push(`begin ${kind}`),
            end: (kind) => marks.push(`end ${kind}`),
          },
        },
      )
      marks.push('called')
      await tick()
      expect(marks).toEqual(['begin new', 'called', 'end new'])
    }
  })

  test('a usage line is said as a notice, with no call', async () => {
    const { env, calls, said } = fakeEnv({ ok: true, flushed: true })
    runContextCommand({ kind: 'usage', text: NEW_USAGE }, env)
    await tick()
    expect(calls).toEqual([])
    expect(said).toEqual([[NEW_USAGE]])
  })
})

describe('runContextCommand deadline', () => {
  test('a call the core never answers releases the pending state and toasts a warning, not an error', async () => {
    const { env, toasts } = fakeEnv({ ok: false, error: new ChatContextDeadlineError() })
    const pending: string[] = []
    env.pending = {
      begin: (kind) => pending.push(`begin ${kind}`),
      end: (kind) => pending.push(`end ${kind}`),
    }
    runContextCommand({ kind: 'compact' }, env)
    await tick()
    expect(pending).toEqual(['begin compact', 'end compact'])
    expect(toasts).toEqual([[CONTEXT_DEADLINE_TEXT, 'warning']])
    expect(CONTEXT_DEADLINE_TEXT).toBe(
      'Still working in the core. Check again in a moment; your messages are not held any more.',
    )
  })
})
