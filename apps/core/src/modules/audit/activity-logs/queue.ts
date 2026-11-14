// The bounded log queue (ADR-0032 §1, docs/specs/activity-logs.md "Capture"). `enqueue` never throws and never waits: when the
// queue is full the oldest event is dropped and `dropped` counts it. A writer drains batches of `batchSize` every `intervalMs`
// (or at once when a full batch waits). A throwing or rejecting sink is reported to `onError` and never rethrown, so a failing
// store cannot fail a model call. After `stop()` the queue refuses new events (counted as dropped) and schedules nothing.

export interface LogQueueOptions<T> {
  /** Writes one batch. A throw or a rejection is caught and passed to `onError`. */
  sink: (batch: T[]) => void | Promise<void>
  /** The most events held; an enqueue beyond it drops the oldest. Default 1000. */
  max?: number
  /** The most events per sink call. Default 50. */
  batchSize?: number
  /** The delay before a waiting batch is drained. Default 250 ms. */
  intervalMs?: number
  /** Called with a sink failure and the batch size. Its own throw is swallowed. */
  onError?: (error: unknown, batchSize: number) => void
}

export interface LogQueue<T> {
  /** Adds one event. Never throws, never waits. */
  enqueue(event: T): void
  /** Resolves when the queue is empty (every event enqueued before the call is written or dropped by a failure). */
  flush(): Promise<void>
  /** Flushes, then clears the timer. Later enqueues are refused. Safe to call more than once. */
  stop(): Promise<void>
  /** Events waiting to be written. */
  readonly size: number
  /** Events dropped by overflow or refused after `stop()`. */
  readonly dropped: number
}

export function createLogQueue<T>(options: LogQueueOptions<T>): LogQueue<T> {
  const max = Math.max(1, options.max ?? 1000)
  const batchSize = Math.max(1, options.batchSize ?? 50)
  const intervalMs = Math.max(0, options.intervalMs ?? 250)
  const buffer: T[] = []
  let dropped = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pumping: Promise<void> | null = null

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const schedule = (delay: number): void => {
    if (stopped || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void pump()
    }, delay)
  }

  const writeOne = async (): Promise<void> => {
    const batch = buffer.splice(0, batchSize)
    try {
      await options.sink(batch)
    } catch (error) {
      try {
        options.onError?.(error, batch.length)
      } catch {
        // a failing error hook must not reject the caller either
      }
    }
  }

  /** Drains until the buffer is empty; concurrent callers share one pass. */
  const pump = (): Promise<void> => {
    if (pumping === null) {
      pumping = (async () => {
        while (buffer.length > 0) await writeOne()
      })().finally(() => {
        pumping = null
      })
    }
    return pumping
  }

  return {
    enqueue(event) {
      try {
        if (stopped) {
          dropped++
          return
        }
        if (buffer.length >= max) {
          buffer.shift()
          dropped++
        }
        buffer.push(event)
        if (buffer.length >= batchSize) {
          clearTimer()
          schedule(0)
        } else schedule(intervalMs)
      } catch {
        // never reached in practice; the contract is that enqueue does not throw
      }
    },
    async flush() {
      clearTimer()
      await pump()
    },
    async stop() {
      stopped = true
      clearTimer()
      await pump()
    },
    get size() {
      return buffer.length
    },
    get dropped() {
      return dropped
    },
  }
}
