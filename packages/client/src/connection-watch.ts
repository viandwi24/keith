import { isHarnessHttpError, isNetworkError } from 'eharness/client'
import type { KeithClient } from './client.ts'
import {
  type ConnectionMonitor,
  type ConnectionMonitorOptions,
  createConnectionMonitor,
} from './connection-monitor.ts'

export type WatchOptions = Pick<ConnectionMonitorOptions, 'clock' | 'windowMs' | 'waitMs'>

/** A failed call in words, without a URL, a token or a message body. */
export function reasonOf(error: unknown): string {
  if (isHarnessHttpError(error)) return `the core answered ${error.status}`
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return `the core answered ${status}`
  const text = `${(error as { code?: unknown } | null)?.code ?? ''} ${(error as Error | null)?.message ?? ''}`
  if (/ECONNREFUSED|refused|Unable to connect/i.test(text)) return 'connection refused'
  if (/timeout|timed out|ETIMEDOUT|abort/i.test(text)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'host not found'
  if (isNetworkError(error)) return 'network error'
  return 'the core did not answer'
}

/**
 * A connection monitor on the client's activity feed: the feed's status goes in, an attempt stops
 * and starts the feed again, and the reason shown while disconnected comes from a `health` call. `stop()` also leaves the feed. The feed itself is not started here.
 */
export function watchConnection(
  client: KeithClient,
  options: WatchOptions = {},
): ConnectionMonitor {
  const feed = client.feed()
  const monitor = createConnectionMonitor({
    ...options,
    restart: () => {
      feed.stop()
      feed.start()
    },
    diagnose: async () => {
      try {
        await client.rpc.health.get()
        return 'the core answers but the live feed is not up'
      } catch (error) {
        return reasonOf(error)
      }
    },
  })
  const off = feed.subscribe((state) => monitor.feedStatus(state.status))
  return {
    ...monitor,
    stop() {
      off()
      monitor.stop()
    },
  }
}
