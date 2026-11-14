import type { KeithClient } from '@keith/client'
import type { ActivityRecord } from 'eharness/client'
import { useEffect, useRef } from 'react'

export interface ActivityHandlers {
  /** Every new record of the activity feed. */
  onRecord(record: ActivityRecord): void
  /** The feed (re)connected or missed events: refetch state (the feed sends no history). */
  onResync(): void
}

/**
 * Run the client's activity feed while mounted and hand records and resyncs to the handlers.
 * Mount it once (the feed is one per client). Listeners are added before `start()` so the first
 * connect resync is not missed.
 */
export function useActivity(client: KeithClient, handlers: ActivityHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const feed = client.feed()
    const offEvents = feed.subscribeEvents((record) => latest.current.onRecord(record))
    const offResync = feed.subscribeResync(() => latest.current.onResync())
    feed.start()
    return () => {
      offEvents()
      offResync()
      feed.stop()
    }
  }, [client])
}
