// The `turn.completed`-driven job that keeps each thread's summary current (ADR-0014).
// See docs/architecture/memory.md#thread-summary.

import type { KeithConfig } from '../../config/types.ts'
import type { CoreEventBus } from '../../events/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Logger, ThreadId } from '../../shared/types.ts'
import type { MemoryJob, ThreadSummarizer } from '../types.ts'

export type SummaryJobDeps = {
  config: Pick<KeithConfig, 'memory'>
  summarizer: ThreadSummarizer
  scheduler: Pick<Scheduler, 'run'>
  events: Pick<CoreEventBus, 'on'>
  log: Logger
}

/**
 * Each `turn.completed` schedules one update of its thread in the `background` lane. Events for
 * a thread whose update is queued or running are coalesced into at most one follow-up.
 */
export function createSummaryJob(deps: SummaryJobDeps): MemoryJob {
  /** Threads with an update queued or running; `again` = one follow-up is owed. */
  const active = new Map<ThreadId, { again: boolean }>()
  const running = new Set<Promise<void>>()
  let unsubscribe: (() => void) | null = null
  let controller = new AbortController()

  function schedule(threadId: ThreadId) {
    const state = active.get(threadId)
    if (state) {
      state.again = true
      return
    }
    const mine = { again: false }
    active.set(threadId, mine)
    const signal = controller.signal
    const p = (async () => {
      try {
        do {
          mine.again = false
          await deps.scheduler.run(
            'background',
            (s) => deps.summarizer.update({ threadId, signal: s }),
            signal,
          )
        } while (mine.again && !signal.aborted)
      } catch (error) {
        if (!signal.aborted) {
          deps.log.error('thread summary update failed', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        active.delete(threadId)
      }
    })()
    running.add(p)
    void p.finally(() => running.delete(p))
  }

  return {
    start() {
      if (unsubscribe !== null || !deps.config.memory.summary.enabled) return
      controller = new AbortController()
      unsubscribe = deps.events.on('turn.completed', (e) => schedule(e.data.threadId))
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = null
      controller.abort()
      await Promise.allSettled([...running])
    },
  }
}
