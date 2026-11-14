/**
 * The creation stack without the probe's own frames: the probe lives in `packages/host/src/`, so a filter on that folder would
 * otherwise match every timer of the process (another file's late feed reconnect made the teardown test fail in the full run).
 */
function callerStack(): string {
  return (new Error().stack ?? '')
    .split('\n')
    .filter((line) => !line.includes('timer-probe.ts'))
    .join('\n')
}

/**
 * Counts the timers a piece of code leaves running: wraps the global timer functions while active. A timer
 * counts as live from creation until it fires (a timeout) or is cleared. For teardown tests.
 *
 * `only` limits the count to timers whose creation stack matches it. `bun test` runs every file in one process, so a
 * timer that another file starts during the window (a late teardown, a retry) is not the code under test; without
 * the filter such a timer made a teardown test fail only in the full run.
 */
export function probeTimers(options: { only?: RegExp } = {}): {
  live(): number
  /** The creation stacks of the live timers (for a failing assertion's message). */
  stacks(): string[]
  stop(): void
} {
  const only = options.only
  const live = new Map<unknown, string>()
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  // biome-ignore lint/suspicious/noExplicitAny: the timer functions are overloaded; the probe forwards every argument
  const g = globalThis as any
  g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = original.setTimeout(
      (...a: unknown[]) => {
        live.delete(handle)
        fn(...a)
      },
      ms,
      ...args,
    )
    const stack = callerStack()
    if (only === undefined || only.test(stack)) live.set(handle, stack)
    return handle
  }
  g.clearTimeout = (handle: unknown) => {
    live.delete(handle)
    return original.clearTimeout(handle as never)
  }
  g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = original.setInterval(fn, ms, ...args)
    const stack = callerStack()
    if (only === undefined || only.test(stack)) live.set(handle, stack)
    return handle
  }
  g.clearInterval = (handle: unknown) => {
    live.delete(handle)
    return original.clearInterval(handle as never)
  }
  return {
    live: () => live.size,
    stacks: () => [...live.values()],
    stop() {
      Object.assign(globalThis, original)
    },
  }
}
