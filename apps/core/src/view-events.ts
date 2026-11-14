import { pluginEventType } from '@keith/contracts'
import type { ViewEventsOptions, ViewEventsPort, Viewer } from '@keith/host/views'
import type { ActivityRecord, ActivityStore } from 'eharness/activity'

/** How often the poller reads the feed while a view listens (docs/specs/plugin-views.md, "Events"). */
export const VIEW_EVENTS_INTERVAL_MS = 500
/** Records read per poll at most; a longer backlog is read over the next polls. */
const PAGE = 200

interface Subscription {
  viewer: string
  type: string
  plugin: string
  handler(data: unknown): void
  onResync?: () => void
}

/**
 * The feed-backed `ViewEventsPort` of the plugin views (docs/specs/plugin-views.md, "Events"): a view's
 * `useKeith().events` gets the same plugin records the activity feed shows its person. One poller reads the
 * activity store by `seq` and runs only while at least one view listens; it stops when the last listener goes.
 *
 * - No history: a subscription starts at the newest record the poller has read, never at the log's start.
 * - The filter is the feed's rule for plugin records (`activityFilter`): the record's `to` is the viewer or `*`.
 * - A prune past the poller's cursor (a resync) moves the cursor to the prune boundary: the pruned records are not
 *   replayed, the survivors are read, and every listener of the view gets `onResync` (its records may be lost).
 */
export function createViewEvents(options: {
  store: ActivityStore
  warn?(message: string): void
  intervalMs?: number
}): ViewEventsPort & { listeners(): number; close(): void } {
  const subs = new Set<Subscription>()
  let cursor: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let starting = false
  let busy = false
  // bumped on every stop, so a start that was still reading the head does not arm a poller after a stop
  let epoch = 0
  const warn = (message: string): void => options.warn?.(message)
  const fail = (error: unknown): void =>
    warn(`views: events: ${error instanceof Error ? error.message : String(error)}`)

  const dispatch = (record: ActivityRecord): void => {
    for (const sub of [...subs]) {
      if (record.type !== sub.type) continue
      const payload = record.payload as { to?: unknown; data?: unknown } | null
      if (payload?.to !== sub.viewer && payload?.to !== '*') continue
      try {
        sub.handler(payload.data)
      } catch (error) {
        warn(`views: events: a handler of ${sub.plugin} threw: ${String(error)}`)
      }
    }
  }

  /** Tells every listener that records may have been lost; a throwing listener is reported, the others still hear it. */
  const resync = (): void => {
    for (const sub of [...subs]) {
      try {
        sub.onResync?.()
      } catch (error) {
        warn(`views: events: a resync handler of ${sub.plugin} threw: ${String(error)}`)
      }
    }
  }

  const tick = (): void => {
    if (busy || cursor === undefined) return
    busy = true
    const epochAtRead = epoch
    const from = cursor
    options.store
      .prunedThrough()
      .then(async (pruned) => {
        if (epochAtRead !== epoch) return
        // a prune reached past the cursor: the pruned records are gone (never replayed), the cursor moves to the
        // boundary and the survivors after it are read as usual
        if (pruned > from) {
          cursor = pruned
          resync()
        }
        const records = await options.store.read({ after: from, limit: PAGE })
        if (epochAtRead !== epoch) return
        for (const record of records) {
          if (cursor !== undefined && record.seq > cursor) cursor = record.seq
          dispatch(record)
        }
      })
      .catch(fail)
      .finally(() => {
        busy = false
      })
  }

  const start = (): void => {
    if (timer !== undefined || starting) return
    starting = true
    const epochAtStart = epoch
    options.store.lastSeq().then(
      (head) => {
        if (epochAtStart !== epoch) return
        starting = false
        if (subs.size === 0) return
        cursor = head
        timer = setInterval(tick, options.intervalMs ?? VIEW_EVENTS_INTERVAL_MS)
      },
      (error: unknown) => {
        if (epochAtStart === epoch) starting = false
        fail(error)
      },
    )
  }

  const halt = (): void => {
    epoch++
    starting = false
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    cursor = undefined
  }

  return {
    subscribe(viewer: Viewer, plugin: string, event: string, handler, options?: ViewEventsOptions) {
      const sub: Subscription = {
        viewer: viewer.principalId,
        type: pluginEventType(plugin, event),
        plugin,
        handler,
        ...(options?.onResync === undefined ? {} : { onResync: options.onResync }),
      }
      subs.add(sub)
      start()
      return () => {
        if (!subs.delete(sub)) return
        if (subs.size === 0) halt()
      }
    },
    listeners: () => subs.size,
    close() {
      subs.clear()
      halt()
    },
  }
}
