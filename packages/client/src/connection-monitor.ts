// The link to the core as a person should see it, on top of the activity feed. The eharness feed
// reconnects by itself and never gives up, so "reconnecting" alone would say nothing for hours.
// This is a small pure state machine (an injectable clock, no I/O of its own): it turns the feed's
// status into live / reconnecting / disconnected and, while disconnected, restarts the feed on a
// fixed rhythm. See docs/specs/client.md (connection monitor).

/** The feed's status words (eharness `FeedStatus`); this module needs no eharness import. */
export type LinkFeedStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'stopped' | 'unauthorized'

export type LinkKind = 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'logged-out'

export interface LinkState {
  kind: LinkKind
  /** `reconnecting`: epoch ms when the window ends (`reconnecting… (3 s)` counts down to it). */
  until?: number
  /** `disconnected`: epoch ms of the next attempt (the countdown). */
  retryAt?: number
  /** `disconnected`: the last error in words (`connection refused`, `timeout`, `core answered 503`), when known. */
  reason?: string
  /** Attempts made since the link dropped. */
  attempts: number
}

export interface MonitorClock {
  now(): number
  /** One-shot timer; returns its cancel function. */
  after(ms: number, fn: () => void): () => void
}

export const realMonitorClock: MonitorClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

/** `retryNow` is honoured at most this often. */
export const RETRY_NOW_GAP_MS = 3_000

export interface ConnectionMonitorOptions {
  /** Restart the feed (stop, then start): one connection attempt. */
  restart(): void
  /** Why the core cannot be reached, in words and without secrets (called when the link is declared down). */
  diagnose?: () => Promise<string | undefined>
  clock?: MonitorClock
  /** The one window a dropped link, or an attempt, has to be live again (default 5 s). */
  windowMs?: number
  /** How long the link stays `disconnected` before the next attempt (default 15 s). */
  waitMs?: number
}

export interface ConnectionMonitor {
  get(): LinkState
  /** Calls `run` with the current state at once, then on every change; returns the unsubscribe. */
  subscribe(run: (state: LinkState) => void): () => void
  /** Feed the feed's status in. */
  feedStatus(status: LinkFeedStatus): void
  /** Start an attempt now when disconnected (at most once per 3 s); returns whether one started. */
  retryNow(): boolean
  /** Cancel every timer and ignore later input. */
  stop(): void
}

/**
 * States: `connecting` until the feed was live once (the first connect is not an outage); `live`;
 * `reconnecting` for one window (5 s) after a drop and for one window per attempt; `disconnected`
 * when the window ended without a live feed, for 15 s with a countdown, then one attempt, forever;
 * `logged-out` when the core refused the credential (terminal: no retries).
 */
export function createConnectionMonitor(options: ConnectionMonitorOptions): ConnectionMonitor {
  const clock = options.clock ?? realMonitorClock
  const windowMs = options.windowMs ?? 5_000
  const waitMs = options.waitMs ?? 15_000
  let state: LinkState = { kind: 'connecting', attempts: 0 }
  let cancel: (() => void) | undefined
  let stopped = false
  let epoch = 0
  let lastRetryNow = Number.NEGATIVE_INFINITY
  const listeners = new Set<(s: LinkState) => void>()

  const set = (next: LinkState): void => {
    state = next
    for (const fn of [...listeners]) fn(state)
  }
  const clear = (): void => {
    cancel?.()
    cancel = undefined
    epoch++
  }
  function disconnect(): void {
    clear()
    const mine = epoch
    set({ kind: 'disconnected', retryAt: clock.now() + waitMs, attempts: state.attempts })
    cancel = clock.after(waitMs, attempt)
    const diagnose = options.diagnose
    if (diagnose === undefined) return
    void diagnose()
      .catch(() => undefined)
      .then((reason) => {
        if (stopped || mine !== epoch || state.kind !== 'disconnected' || reason === undefined) {
          return
        }
        set({ ...state, reason })
      })
  }
  function reconnecting(attempts: number): void {
    clear()
    set({ kind: 'reconnecting', until: clock.now() + windowMs, attempts })
    cancel = clock.after(windowMs, disconnect)
  }
  function attempt(): void {
    if (stopped || state.kind !== 'disconnected') return
    reconnecting(state.attempts + 1)
    options.restart()
  }

  return {
    get: () => state,
    subscribe(run) {
      listeners.add(run)
      run(state)
      return () => {
        listeners.delete(run)
      }
    },
    feedStatus(status) {
      if (stopped || state.kind === 'logged-out') return
      if (status === 'unauthorized') {
        clear()
        set({ kind: 'logged-out', attempts: state.attempts })
      } else if (status === 'live') {
        if (state.kind === 'live') return
        clear()
        set({ kind: 'live', attempts: 0 })
      } else if (state.kind === 'live') {
        reconnecting(0)
      }
      // connecting (never live), reconnecting and disconnected: the feed's own churn changes nothing
    },
    retryNow() {
      const now = clock.now()
      if (stopped || state.kind !== 'disconnected' || now - lastRetryNow < RETRY_NOW_GAP_MS) {
        return false
      }
      lastRetryNow = now
      attempt()
      return true
    },
    stop() {
      stopped = true
      clear()
      listeners.clear()
    },
  }
}
