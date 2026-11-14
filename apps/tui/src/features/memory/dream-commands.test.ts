import { describe, expect, test } from 'bun:test'
import type { DreamingApi } from '@keith/client'
import type { DreamRefusalReason, DreamRunView, DreamStatusView } from '@keith/contracts'
import {
  DREAM_MODE_USAGE,
  DREAM_USAGE,
  type DreamCommandEnv,
  parseDreamCommand,
  runDreamCommand,
} from './dream-commands.ts'
import { DREAM_REFUSAL_TEXT, runOutcomeOf, stagedEntriesOf, statusRowsOf } from './dream-state.ts'

const RUN: DreamRunView = {
  id: 'run-1',
  trigger: 'manual',
  mode: 'propose',
  status: 'staged',
  reason: null,
  startedAt: new Date(2026, 10, 10, 3, 0).getTime(),
  finishedAt: null,
  counts: { candidates: 3, promoted: 1, merged: 0, superseded: 1, dropped: 1 },
  applied: false,
  staged: true,
}
const STATUS: DreamStatusView = {
  mode: 'propose',
  lastRun: RUN,
  nextRunAt: null,
  canApply: true,
  canUndo: false,
}

/** A CONFLICT as the client's typed call throws it. */
const refusedError = (reason: DreamRefusalReason) => ({
  code: 'CONFLICT',
  message: 'refused',
  data: { reason },
})

function fakeEnv(over: Partial<DreamingApi> = {}) {
  const toasts: Array<[string, string]> = []
  const said: Array<[string, readonly string[]]> = []
  const dreaming: DreamCommandEnv['dreaming'] = {
    status: async () => STATUS,
    setMode: async ({ mode }) => ({ ...STATUS, mode }),
    runNow: async () => RUN,
    apply: async () => ({ ...RUN, status: 'applied', applied: true, staged: false }),
    undo: async () => ({ runId: 'run-0', restored: 2, skipped: [] }),
    ...over,
  }
  const env: DreamCommandEnv = {
    dreaming,
    say: (level, rows) => said.push([level, rows]),
    toast: (text, level) => toasts.push([text, level]),
  }
  return { env, toasts, said }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('parseDreamCommand', () => {
  test('the forms and the usage line', () => {
    expect(parseDreamCommand('')).toEqual({ kind: 'status' })
    expect(parseDreamCommand('  now ')).toEqual({ kind: 'now' })
    expect(parseDreamCommand('apply')).toEqual({ kind: 'apply' })
    expect(parseDreamCommand('undo')).toEqual({ kind: 'undo' })
    expect(parseDreamCommand('mode propose')).toEqual({ kind: 'mode', mode: 'propose' })
    expect(parseDreamCommand('mode auto')).toEqual({ kind: 'mode', mode: 'auto' })
    expect(parseDreamCommand('mode off')).toEqual({ kind: 'mode', mode: 'off' })
    expect(parseDreamCommand('mode always')).toEqual({ kind: 'usage', text: DREAM_MODE_USAGE })
    expect(parseDreamCommand('mode')).toEqual({ kind: 'usage', text: DREAM_MODE_USAGE })
    expect(parseDreamCommand('now please')).toEqual({ kind: 'usage', text: DREAM_USAGE })
    expect(parseDreamCommand('apply --force')).toEqual({ kind: 'usage', text: DREAM_USAGE })
  })
})

describe('runDreamCommand', () => {
  test('/dream shows the status as an info notice', async () => {
    const { env, said, toasts } = fakeEnv()
    runDreamCommand({ kind: 'status' }, env)
    await settle()
    expect(said[0]?.[0]).toBe('info')
    expect(said[0]?.[1]).toContain('Dreaming: propose (/dream mode off · propose · auto)')
    expect(said[0]?.[1]).toContain('A staged plan waits: /dream apply.')
    expect(toasts).toEqual([])
  })

  test('/dream mode sets the mode and says it in a toast', async () => {
    const calls: unknown[] = []
    const { env, toasts } = fakeEnv({
      setMode: async (input) => {
        calls.push(input)
        return { ...STATUS, mode: input.mode }
      },
    })
    runDreamCommand({ kind: 'mode', mode: 'auto' }, env)
    await settle()
    expect(calls).toEqual([{ mode: 'auto' }])
    expect(toasts).toEqual([['Dreaming mode: auto.', 'success']])
  })

  test('/dream now says the outcome of the run', async () => {
    const staged = fakeEnv()
    runDreamCommand({ kind: 'now' }, staged.env)
    await settle()
    expect(staged.toasts[0]?.[0]).toContain('Dream run staged: 3 candidates')
    expect(staged.toasts[0]?.[0]).toContain('/dream apply')
    expect(staged.toasts[0]?.[1]).toBe('info')
  })

  test('/dream apply refused with staged-changed says the plan was dropped, and does not tell the person to run /dream now', async () => {
    const { env, toasts } = fakeEnv({
      apply: async () => {
        throw refusedError('staged-changed')
      },
    })
    runDreamCommand({ kind: 'apply' }, env)
    await settle()
    expect(toasts).toEqual([
      [
        'Your memory changed after this plan was made, so the plan was dropped. The next dream plans again.',
        'warning',
      ],
    ])
  })

  test('/dream apply that stopped while writing says so, with the undo words, and does not say Applied', async () => {
    const { env, toasts } = fakeEnv({
      apply: async () => ({
        ...RUN,
        status: 'failed',
        reason: 'apply-partial',
        applied: false,
        staged: false,
      }),
    })
    runDreamCommand({ kind: 'apply' }, env)
    await settle()
    expect(toasts).toEqual([
      [
        'Dream run failed: the dream stopped while writing; /dream undo puts back what it changed.',
        'error',
      ],
    ])
  })

  test('/dream apply writes the last staged run; without one it says so and calls nothing', async () => {
    const applied: unknown[] = []
    const yes = fakeEnv({
      apply: async (input) => {
        applied.push(input)
        return { ...RUN, status: 'applied', applied: true, staged: false }
      },
    })
    runDreamCommand({ kind: 'apply' }, yes.env)
    await settle()
    expect(applied).toEqual([{ runId: 'run-1' }])
    expect(yes.toasts).toEqual([
      ['Applied: 3 candidates: 1 promoted, 0 merged, 1 superseded, 1 dropped.', 'success'],
    ])

    const none = fakeEnv({
      status: async () => ({ ...STATUS, canApply: false }),
      apply: async () => {
        throw new Error('must not be called')
      },
    })
    runDreamCommand({ kind: 'apply' }, none.env)
    await settle()
    expect(none.toasts).toEqual([['No staged plan to apply.', 'info']])
  })

  test('/dream apply applies the run that holds the staged plan, not the last run (a later skipped run does not hide it)', async () => {
    const applied: unknown[] = []
    const skipped: DreamRunView = { ...RUN, id: 'run-2', status: 'skipped', staged: false }
    const env = fakeEnv({
      status: async () => ({ ...STATUS, lastRun: skipped, stagedRunId: 'run-1' }),
      apply: async (input) => {
        applied.push(input)
        return { ...RUN, status: 'applied', applied: true, staged: false }
      },
    })
    runDreamCommand({ kind: 'apply' }, env.env)
    await settle()
    expect(applied).toEqual([{ runId: 'run-1' }])
  })

  test('/dream undo says how many files came back', async () => {
    const { env, toasts } = fakeEnv()
    runDreamCommand({ kind: 'undo' }, env)
    await settle()
    expect(toasts).toEqual([['Undone: 2 file(s) restored from run run-0.', 'success']])
  })

  test('/dream undo names the files it kept because they changed after the dream', async () => {
    const { env, toasts } = fakeEnv({
      undo: async () => ({ runId: 'run-0', restored: 1, skipped: ['recent.md'] }),
    })
    runDreamCommand({ kind: 'undo' }, env)
    await settle()
    expect(toasts).toEqual([
      [
        'Undone: 1 file(s) restored from run run-0. kept recent.md: it changed after this dream.',
        'warning',
      ],
    ])
  })

  test('every refusal reason has a plain toast text', async () => {
    const reasons = Object.keys(DREAM_REFUSAL_TEXT) as DreamRefusalReason[]
    expect(reasons.sort()).toEqual([
      'budget',
      'few-messages',
      'no-model',
      'nothing-to-undo',
      'off',
      'staged-changed',
      'too-soon',
      'turn-running',
    ])
  })

  test('a skipped run names its refusal reason', () => {
    const skipped = { ...RUN, status: 'skipped', reason: 'few-messages' } as DreamRunView
    expect(runOutcomeOf(skipped)).toEqual({
      text: 'Dream run skipped: not enough new messages.',
      level: 'warning',
    })
  })

  test('the status rows name the undo and the next window when they apply', () => {
    const rows = statusRowsOf({
      ...STATUS,
      lastRun: null,
      canApply: false,
      canUndo: true,
      nextRunAt: new Date(2026, 10, 11, 9, 30).getTime(),
    })
    expect(rows).toEqual([
      'Dreaming: propose (/dream mode off · propose · auto)',
      'Last run: none yet.',
      'Undo is available: /dream undo.',
      'Next run may start from 2026-11-11 09:30.',
    ])
  })

  test('stagedEntriesOf reads only the section of its run', () => {
    const text = [
      '# Dreams 2026-11-10',
      '',
      '## run run-0',
      '- promoted -> profile.md: Likes tea (asked twice)',
      '## run run-1',
      '- proposed -> profile.md: Lives in Bandung (said so in chat)',
      '- proposed: Keeps a cat (mentioned on two days)',
      '## run run-2',
      '- dropped: old note',
    ].join('\n')
    expect(stagedEntriesOf({ text }, 'run-1')).toEqual([
      '- proposed -> profile.md: Lives in Bandung (said so in chat)',
      '- proposed: Keeps a cat (mentioned on two days)',
    ])
    expect(stagedEntriesOf({ text }, 'run-9')).toEqual([])
  })
})

describe('/dream now in the chat: the divider, not a toast', () => {
  test('a run that ends on the chat screen goes to the chat and raises no toast', async () => {
    const { env, toasts } = fakeEnv()
    const finished: DreamRunView[] = []
    runDreamCommand(
      { kind: 'now' },
      { ...env, inChat: { finish: (run) => finished.push(run), refused: () => undefined } },
    )
    await settle()
    expect(finished).toEqual([RUN])
    expect(toasts).toEqual([])
  })

  test('a refusal on the chat screen goes to the chat with its reason; no toast', async () => {
    const { env, toasts } = fakeEnv({
      runNow: async () => {
        throw refusedError('too-soon')
      },
    })
    const refusals: DreamRefusalReason[] = []
    runDreamCommand(
      { kind: 'now' },
      { ...env, inChat: { finish: () => undefined, refused: (r) => refusals.push(r) } },
    )
    await settle()
    expect(refusals).toEqual(['too-soon'])
    expect(toasts).toEqual([])
  })

  test('off the chat screen the outcome is a toast, as before', async () => {
    const { env, toasts } = fakeEnv()
    runDreamCommand({ kind: 'now' }, env)
    await settle()
    expect(toasts).toEqual([[runOutcomeOf(RUN).text, runOutcomeOf(RUN).level]])
  })
})
