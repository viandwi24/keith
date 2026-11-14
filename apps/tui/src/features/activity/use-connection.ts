import {
  type ConnectionMonitor,
  type KeithClient,
  type LinkState,
  type MonitorClock,
  watchConnection,
} from '@keith/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type LinkTuning, loadLinkTuning } from '../../platform/config.ts'

export interface ConnectionState {
  /**
   * `connecting` until the feed was live once; `live`; `reconnecting` after a drop (up to the
   * timeout) and during each retry; `disconnected` when a reconnect took too long (red, with a retry
   * every 15 s); `logged-out` when the core refused the credential (no retries).
   */
  kind: 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'logged-out'
  /** The core refused the credential: the feed is terminal until a new login. */
  loggedOut: boolean
  /** `disconnected`: epoch ms of the next attempt, and the last error in words. */
  retryAt?: number
  reason?: string
  /** `reconnecting`: epoch ms when the window ends. */
  until?: number
  /** Start an attempt now when disconnected (once per 3 s); `false` when none started. */
  retry(): boolean
}

export function connectionOf(link: LinkState, retry: () => boolean = () => false): ConnectionState {
  switch (link.kind) {
    case 'logged-out':
      return { kind: 'logged-out', loggedOut: true, retry }
    case 'live':
      return { kind: 'live', loggedOut: false, retry }
    case 'reconnecting':
      return {
        kind: 'reconnecting',
        loggedOut: false,
        retry,
        ...(link.until === undefined ? {} : { until: link.until }),
      }
    case 'disconnected':
      return {
        kind: 'disconnected',
        loggedOut: false,
        retry,
        ...(link.retryAt === undefined ? {} : { retryAt: link.retryAt }),
        ...(link.reason === undefined ? {} : { reason: link.reason }),
      }
    default:
      return { kind: 'connecting', loggedOut: false, retry }
  }
}

/**
 * The link to the core: the connection monitor (`@keith/client`) on the activity feed. The hook
 * owns the monitor: it starts with the client and its timers stop on unmount. `clock` is for tests.
 */
export function useConnection(
  client: KeithClient,
  tuning?: LinkTuning,
  clock?: MonitorClock,
): ConnectionState {
  const own = useMemo(() => tuning ?? loadLinkTuning(), [tuning])
  const [link, setLink] = useState<LinkState>({ kind: 'connecting', attempts: 0 })
  const monitor = useRef<ConnectionMonitor | undefined>(undefined)
  useEffect(() => {
    const m = watchConnection(client, {
      windowMs: own.windowMs,
      waitMs: own.waitMs,
      ...(clock === undefined ? {} : { clock }),
    })
    monitor.current = m
    const off = m.subscribe(setLink)
    return () => {
      off()
      m.stop()
      monitor.current = undefined
    }
  }, [client, own.windowMs, own.waitMs, clock])
  const retry = useCallback(() => monitor.current?.retryNow() ?? false, [])
  return useMemo(() => connectionOf(link, retry), [link, retry])
}
