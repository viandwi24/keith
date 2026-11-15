import {
  type ElectionAction,
  type ElectionMessage,
  initialElection,
  stepElection,
} from './election.ts'

export interface LeaderOptions {
  /** This tab is the one that reports presence. */
  onLead(): void
  /** This tab no longer is. */
  onFollow(): void
}

const LOCK = 'keith.presence'
const CHANNEL = 'keith.presence'
const TICK_MS = 500

const isMessage = (value: unknown): value is ElectionMessage => {
  const m = value as { type?: unknown; from?: unknown } | null
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.from === 'string' &&
    (m.type === 'claim' || m.type === 'beat' || m.type === 'resign')
  )
}

/** Hold the lead through the Web Locks API: the tab that gets the lock reports; when it closes the browser hands the lock on. */
function withLocks(locks: LockManager, options: LeaderOptions): () => void {
  const abort = new AbortController()
  let release: (() => void) | undefined
  locks
    .request(LOCK, { signal: abort.signal }, () => {
      options.onLead()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    .catch(() => undefined) // an aborted wait is the normal way out
  return () => {
    const held = release !== undefined
    release?.()
    abort.abort()
    if (held) options.onFollow()
  }
}

/** The fallback: a leader election over a BroadcastChannel (`election.ts`), for a browser without Web Locks. */
function withChannel(options: LeaderOptions): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    // nothing to talk over (a very old browser): this tab reports alone
    options.onLead()
    return () => options.onFollow()
  }
  const channel = new BroadcastChannel(CHANNEL)
  let state = initialElection(crypto.randomUUID(), Date.now())
  const run = (actions: ElectionAction[]): void => {
    for (const action of actions) {
      if (action.type === 'send') channel.postMessage(action.message)
      else if (action.type === 'lead') options.onLead()
      else options.onFollow()
    }
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isMessage(event.data)) return
    const step = stepElection(state, { type: 'message', message: event.data, at: Date.now() })
    state = step.state
    run(step.actions)
  }
  const timer = setInterval(() => {
    const step = stepElection(state, { type: 'tick', at: Date.now() })
    state = step.state
    run(step.actions)
  }, TICK_MS)
  return () => {
    clearInterval(timer)
    const step = stepElection(state, { type: 'leave', at: Date.now() })
    state = step.state
    run(step.actions)
    channel.close()
  }
}

/** Take part in the election of the one tab of this browser that reports presence; returns the way out. */
export function electLeader(options: LeaderOptions): () => void {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  return locks === undefined ? withChannel(options) : withLocks(locks, options)
}
