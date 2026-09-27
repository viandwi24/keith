// The reflection job: on each scheduler tick, reflect threads that have been idle long enough.
// See docs/architecture/memory.md#reflection.

import type { ThreadId } from '../../shared/types.ts'
import type { MemoryJob, Reflector } from '../types.ts'
import type { ReflectionDeps } from './index.ts'

/** Threads picked up per tick; the next tick takes the rest. */
export const REFLECT_PER_TICK = 4

type JobDeps = Pick<ReflectionDeps, 'config' | 'repos' | 'scheduler' | 'events' | 'clock' | 'log'> & {
  reflector: Reflector
}

export function createReflectionJob(deps: JobDeps): MemoryJob {
  const running = new Map<ThreadId, { controller: AbortController; done: Promise<void> }>()
  let unsubscribe: (() => void) | null = null

  async function tick(): Promise<void> {
    const { idleMinutes } = deps.config.memory.reflect
    const idleBefore = deps.clock.now() - idleMinutes * 60_000
    const due = await deps.repos.threads.listForReflection({ idleBefore, limit: REFLECT_PER_TICK })
    for (const { thread } of due) {
      // Stopped while listing, or a pass for this thread is still in flight.
      if (unsubscribe === null || running.has(thread.id)) continue
      startPass(thread.id)
    }
  }

  function startPass(threadId: ThreadId): void {
    const controller = new AbortController()
    const done = deps.scheduler
      .run(
        'background',
        (signal) =>
          deps.reflector.reflect({ threadId, signal: AbortSignal.any([signal, controller.signal]) }),
        controller.signal,
      )
      .then(
        () => undefined,
        (error: unknown) => {
          if (!controller.signal.aborted)
            deps.log.warn('reflection pass failed', { threadId, error: String(error) })
        },
      )
      .finally(() => {
        running.delete(threadId)
      })
    running.set(threadId, { controller, done })
  }

  return {
    start() {
      if (unsubscribe !== null || !deps.config.memory.reflect.enabled) return
      unsubscribe = deps.events.on('scheduler.ticked', () =>
        tick().catch((error: unknown) => {
          deps.log.warn('reflection tick failed', { error: String(error) })
        }),
      )
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = null
      const passes = [...running.values()]
      for (const p of passes) p.controller.abort()
      await Promise.allSettled(passes.map((p) => p.done))
    },
  }
}
