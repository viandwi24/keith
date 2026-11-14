import { afterEach, describe, expect, test } from 'bun:test'
import { chatReady, frameUntil, typeLine } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const SESSION = 'front:owner'

const until = async (check: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

const start = (runId: string) => ({
  type: 'brain.hippocampus.dream',
  sessionId: SESSION,
  payload: {
    region: 'hippocampus',
    runId,
    phase: 'start',
    trigger: 'schedule',
    candidates: 0,
    promoted: 0,
    merged: 0,
    superseded: 0,
    dropped: 0,
    applied: false,
  },
})

const end = (
  runId: string,
  counts: {
    candidates: number
    promoted: number
    merged: number
    superseded: number
    dropped: number
  },
  applied = false,
) => ({
  type: 'brain.hippocampus.dream',
  sessionId: SESSION,
  payload: { region: 'hippocampus', runId, phase: 'end', trigger: 'schedule', ...counts, applied },
})

const run = (
  id: string,
  status: string,
  reason: string | null,
  counts = { candidates: 3, promoted: 1, merged: 1, superseded: 0, dropped: 1 },
) => ({
  id,
  trigger: 'schedule',
  mode: 'propose',
  status,
  reason,
  startedAt: Date.now(),
  finishedAt: Date.now(),
  counts,
  applied: status === 'applied',
  staged: status === 'staged',
})

describe('a memory dream in the chat', () => {
  test('the running line counts the seconds, the input stays usable, the end leaves one divider', async () => {
    let last = run('r1', 'staged', null)
    const { lastFrame, stdin, core, unmount } = await setupApp({
      rpc: {
        'dream/status': () => ({
          mode: 'propose',
          lastRun: last,
          nextRunAt: null,
          canApply: true,
          canUndo: false,
        }),
      },
    })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    core.emit(start('r1'))
    await frameUntil(lastFrame, (f) => f.includes('dreaming · 0 s'))
    // the input takes a message while the dream runs
    await typeLine(stdin, 'still here')
    await frameUntil(lastFrame, (f) => f.includes('still here'))
    last = run('r1', 'staged', null)
    core.emit(end('r1', { candidates: 3, promoted: 1, merged: 1, superseded: 0, dropped: 1 }))
    const done = await frameUntil(lastFrame, (f) => f.includes('dream finished'))
    expect(done).toContain('dream finished · 3 reviewed · 2 changes waiting (/dream apply)')
    expect(done).not.toContain('dreaming · ')
    expect(done.split('dream finished').length - 1).toBe(1)
    unmount()
  })

  test('a failed run names its cause in the divider even when the status moved on to a newer run', async () => {
    const { lastFrame, core, unmount } = await setupApp({
      rpc: {
        'dream/status': () => ({
          mode: 'propose',
          lastRun: run('newer', 'applied', null),
          nextRunAt: null,
          canApply: false,
          canUndo: true,
        }),
      },
    })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    core.emit({
      type: 'brain.hippocampus.dream',
      sessionId: SESSION,
      payload: {
        region: 'hippocampus',
        runId: 'old',
        phase: 'end',
        trigger: 'schedule',
        candidates: 0,
        promoted: 0,
        merged: 0,
        superseded: 0,
        dropped: 0,
        applied: false,
        status: 'failed',
        reason: 'judge',
      },
    })
    // the Brain panel's trace also says `dream failed · the model'…` (clipped): wait for the chat divider's full words
    const done = await frameUntil(lastFrame, (f) =>
      f.includes("dream failed · the model's plan was not valid"),
    )
    expect(done).toContain("dream failed · the model's plan was not valid")
    expect(done).not.toContain('nothing to change')
    unmount()
  })

  test('a start that carries the candidate count shows reviewing N notes in the running line', async () => {
    const { lastFrame, core, unmount } = await setupApp({})
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    core.emit({ ...start('rv1'), payload: { ...start('rv1').payload, candidates: 4 } })
    const running = await frameUntil(lastFrame, (f) => f.includes('dreaming · reviewing 4 notes'))
    expect(running).toContain('dreaming · reviewing 4 notes · 0 s')
    unmount()
  })

  test('each outcome reads in one divider: applied, nothing to change, failed, skipped, rejected', async () => {
    let last = run('a1', 'applied', null)
    const { lastFrame, core, unmount } = await setupApp({
      rpc: {
        'dream/status': () => ({
          mode: 'auto',
          lastRun: last,
          nextRunAt: null,
          canApply: false,
          canUndo: true,
        }),
      },
    })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    const none = { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 }
    const outcomes: Array<{
      id: string
      status: string
      reason: string | null
      counts: typeof none
      text: string
    }> = [
      {
        id: 'a1',
        status: 'applied',
        reason: null,
        counts: { candidates: 3, promoted: 1, merged: 1, superseded: 0, dropped: 1 },
        text: 'dream finished · 3 reviewed · 2 changes saved (/dream undo within 7 days)',
      },
      {
        id: 'f1',
        status: 'failed',
        reason: 'judge',
        counts: none,
        text: "dream failed · the model's plan was not valid",
      },
      {
        id: 's1',
        status: 'skipped',
        reason: 'budget-low',
        counts: none,
        text: 'Skipped: your budget is nearly used up.',
      },
      {
        id: 'j1',
        status: 'rejected',
        reason: null,
        counts: { ...none, candidates: 2 },
        text: 'dream rejected · the plan was not accepted; nothing was written.',
      },
    ]
    for (const o of outcomes) {
      last = run(o.id, o.status, o.reason, o.counts)
      core.emit(start(o.id))
      core.emit(end(o.id, o.counts, o.status === 'applied'))
      await frameUntil(lastFrame, (f) => f.includes(o.text))
    }
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('dreaming · ')
    unmount()
  })

  test('/dream now in the chat shows its outcome as the divider, not as a toast', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      rpc: {
        'dream/now': () => run('n1', 'staged', null),
        'dream/status': () => ({
          mode: 'propose',
          lastRun: run('n1', 'staged', null),
          nextRunAt: null,
          canApply: true,
          canUndo: false,
        }),
      },
    })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    await typeLine(stdin, '/dream now')
    stdin.write('\r')
    const frame = await frameUntil(lastFrame, (f) => f.includes('dream finished'))
    expect(frame).toContain('dream finished · 3 reviewed · 2 changes waiting (/dream apply)')
    expect(frame).not.toContain('Dream run staged')
    unmount()
  })

  test('on Home the caption says dreaming… while the run runs', async () => {
    const { lastFrame, core, unmount } = await setupApp({ start: 'home' })
    await until(() => core.streams() > 0, 'the activity stream')
    core.emit(start('h1'))
    await frameUntil(lastFrame, (f) => f.includes('dreaming…'))
    core.emit(end('h1', { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 }))
    await frameUntil(lastFrame, (f) => !f.includes('dreaming…'))
    unmount()
  })
})
