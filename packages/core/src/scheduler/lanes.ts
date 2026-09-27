// The three scheduler lanes (I-5) and the tick timer. See docs/architecture/core.md#scheduler.

import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { Clock, Lane, Logger } from '../shared/types.ts'
import type { Scheduler } from './types.ts'

export type LaneScheduler = Scheduler & {
  /** Starts the tick timer that emits `scheduler.ticked` every `scheduler.tickMs`. Idempotent. */
  startTicking(): void
  stopTicking(): void
  /** Running and waiting jobs per lane. For tests and diagnostics. */
  load(lane: Lane): { running: number; waiting: number }
}

export type LaneSchedulerDeps = {
  config: Pick<KeithConfig, 'scheduler'>
  clock: Clock
  events: CoreEventBus
  log: Logger
}

type Waiter = { grant: () => void }

type Pool = { limit: number; running: number; waiting: Waiter[] }

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('the job was aborted', 'AbortError')
}

/**
 * Each lane has its own pool, so a full `background` lane never delays `foreground` jobs. Within a
 * lane, jobs start in FIFO order. A job whose signal aborts while it waits is dropped from the
 * queue and rejects with the signal's reason, like `fetch`.
 */
export function createLaneScheduler(deps: LaneSchedulerDeps): LaneScheduler {
  const { config, clock, events, log } = deps
  const pools: Record<Lane, Pool> = {
    foreground: { limit: Math.max(1, config.scheduler.foreground), running: 0, waiting: [] },
    delivery: { limit: Math.max(1, config.scheduler.delivery), running: 0, waiting: [] },
    background: { limit: Math.max(1, config.scheduler.background), running: 0, waiting: [] },
  }
  let timer: ReturnType<typeof setInterval> | null = null

  const acquire = (pool: Pool, signal: AbortSignal | undefined): Promise<void> => {
    if (pool.running < pool.limit) {
      pool.running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = pool.waiting.indexOf(waiter)
        if (i >= 0) pool.waiting.splice(i, 1)
        reject(signal === undefined ? new Error('aborted') : abortReason(signal))
      }
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          pool.running++
          resolve()
        },
      }
      pool.waiting.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  const release = (pool: Pool) => {
    pool.running--
    const next = pool.waiting.shift()
    if (next) next.grant()
  }

  return {
    async run(lane, job, signal) {
      if (signal?.aborted) throw abortReason(signal)
      const pool = pools[lane]
      await acquire(pool, signal)
      try {
        return await job(signal ?? new AbortController().signal)
      } finally {
        release(pool)
      }
    },
    startTicking() {
      if (timer !== null) return
      timer = setInterval(() => {
        const at = clock.now()
        log.debug('scheduler ticked', { at })
        events.emit('scheduler.ticked', { at })
      }, config.scheduler.tickMs)
    },
    stopTicking() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
    load(lane) {
      const pool = pools[lane]
      return { running: pool.running, waiting: pool.waiting.length }
    },
  }
}
