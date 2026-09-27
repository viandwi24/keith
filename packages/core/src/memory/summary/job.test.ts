import { describe, expect, test } from 'bun:test'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { createEventBus } from '../../events/index.ts'
import { createFakeScheduler, testConfig } from '../../mind/testing/fakes.ts'
import type { ThreadId } from '../../shared/types.ts'
import type { ThreadSummarizer } from '../types.ts'
import { createSummaryJob } from './job.ts'

const THREAD = 'thr_00000000000000000000000001' as const
const TURN = 'trn_00000000000000000000000001' as const

type Call = { threadId: ThreadId; signal: AbortSignal }

/** A summarizer whose updates wait on `gate` (open by default). */
function fakeSummarizer() {
  const calls: Call[] = []
  let release: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const s: ThreadSummarizer & { calls: Call[]; hold(): void; open(): void } = {
    calls,
    hold() {
      gate = new Promise((resolve) => {
        release = resolve
      })
    },
    open() {
      release()
      gate = Promise.resolve()
    },
    async update(a) {
      calls.push(a)
      const g = gate
      await new Promise<void>((resolve, reject) => {
        a.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        void g.then(resolve)
      })
      return true
    },
  }
  return s
}

function setup(enabled = true) {
  const clock = createFakeClock(0)
  const log = createMemoryLogger()
  const events = createEventBus({ log, clock })
  const scheduler = createFakeScheduler()
  const summarizer = fakeSummarizer()
  const job = createSummaryJob({
    config: testConfig({}, { summary: { enabled } }),
    summarizer,
    scheduler,
    events,
    log,
  })
  const completed = () =>
    events.emit('turn.completed', { threadId: THREAD, turnId: TURN, steps: 1, cancelled: false })
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await events.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { events, scheduler, summarizer, job, completed, settle }
}

describe('thread summary job', () => {
  test('turn.completed triggers one background update', async () => {
    const s = setup()
    s.job.start()
    s.completed()
    await s.settle()
    expect(s.summarizer.calls.map((c) => c.threadId)).toEqual([THREAD])
    expect(s.scheduler.lanes).toEqual(['background'])
    await s.job.stop()
  })

  test('a burst of five events for one thread makes at most two updates', async () => {
    const s = setup()
    s.job.start()
    s.summarizer.hold()
    for (let i = 0; i < 5; i++) s.completed()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(1)
    s.summarizer.open()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(2)
    // A later event starts a fresh update.
    s.completed()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(3)
    await s.job.stop()
  })

  test('enabled = false does nothing', async () => {
    const s = setup(false)
    s.job.start()
    s.completed()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(0)
    await s.job.stop()
  })

  test('stop() aborts the running update, waits for it and unsubscribes', async () => {
    const s = setup()
    s.job.start()
    s.summarizer.hold()
    s.completed()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(1)
    await s.job.stop()
    expect(s.summarizer.calls[0]?.signal.aborted).toBe(true)
    s.summarizer.open()
    s.completed()
    await s.settle()
    expect(s.summarizer.calls).toHaveLength(1)
  })
})
