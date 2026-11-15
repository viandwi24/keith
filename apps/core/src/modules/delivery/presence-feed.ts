// Watches the activity feed for `brain.parietal.presence` and tells the delivery service when a person is back
// (docs/specs/delivery.md "Hold and digest"). Same reading as the protocol event triggers: a cursor over `store.read`,
// started at the newest record, so a record from before boot is never replayed (the delivery tick covers a missed one).
import { ParietalPresencePayloadSchema } from '@keith/contracts'

/** The part of the activity store this watcher reads. */
export interface PresenceFeedPort {
  read(query: {
    after: number
    limit: number
    types: string[]
  }): Promise<{ seq: number; payload: unknown }[]>
  lastSeq(): Promise<number>
}

export interface PresenceFeedOptions {
  feed: PresenceFeedPort
  /** A person is active or idle again: release what was held. */
  onBack(personId: string): Promise<void>
  everyMs: number
  warn(message: string): void
}

export interface PresenceFeed {
  /** Reads the new presence records once and releases for each person who came back. */
  poll(): Promise<void>
  start(): void
  stop(): void
}

const BATCH = 100
/** The states of a person who can be told things again. */
const BACK_STATES: readonly string[] = ['active', 'idle']

export function createPresenceFeed(options: PresenceFeedOptions): PresenceFeed {
  const { feed, onBack, warn } = options
  let cursor: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false

  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      if (cursor === undefined) {
        cursor = await feed.lastSeq()
        return
      }
      for (;;) {
        const records = await feed.read({
          after: cursor,
          limit: BATCH,
          types: ['brain.parietal.presence'],
        })
        const back = new Set<string>()
        for (const record of records) {
          cursor = Math.max(cursor, record.seq)
          const parsed = ParietalPresencePayloadSchema.safeParse(record.payload)
          if (parsed.success && BACK_STATES.includes(parsed.data.state))
            back.add(parsed.data.personId)
        }
        for (const personId of back) await onBack(personId)
        if (records.length < BATCH) return
      }
    } finally {
      polling = false
    }
  }

  const pollLogged = (): void => {
    poll().catch((error: unknown) =>
      warn(`delivery: presence feed failed: ${error instanceof Error ? error.message : error}`),
    )
  }

  return {
    poll,
    start() {
      pollLogged()
      timer = setInterval(pollLogged, options.everyMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
