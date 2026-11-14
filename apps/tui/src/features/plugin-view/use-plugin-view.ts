import type { KeithClient, ParsedFrame, ViewConnection, ViewEndReason } from '@keith/client'
import { useCallback, useEffect, useRef, useState } from 'react'

/** After this long without an answer the panel says the link is slow (docs/specs/tui.md, "Plugin views"). */
export const SLOW_LINK_MS = 400
/** After this long without a `ready` the attempt is given up: the panel shows a timeout and `r` retries. */
export const PENDING_TIMEOUT_MS = 10_000

export interface PluginViewState {
  /**
   * `connecting` until the core answers `ready`, `open` while frames flow, `ended` with a reason, and `timeout` when
   * no answer came within {@link PENDING_TIMEOUT_MS} (the connection is closed; `reopen()` starts a fresh attempt).
   */
  phase: 'connecting' | 'open' | 'ended' | 'timeout'
  /** True while `connecting` for longer than {@link SLOW_LINK_MS}. */
  slow: boolean
  /** The newest frame, already sanitised by the client; kept after the view ends so the last screen stays visible. */
  frame: ParsedFrame | undefined
  reason: ViewEndReason | undefined
}

export interface PluginViewOptions {
  client: Pick<KeithClient, 'openView'>
  viewId: string
  cols: number
  rows: number
  colorDepth: 1 | 4 | 8 | 24
  /** Test seam: the two waits of a slow or dropped connection (defaults: the constants above). */
  timing?: { slowMs?: number; timeoutMs?: number }
}

/**
 * One plugin view: opens it on mount, keeps the newest frame, forwards the size, closes it on unmount. There is no
 * reconnect (a view lives only as long as its socket): `reopen()` is the person's action after it ended or timed out.
 * Keys are never held back by a pending attempt: the screen handles `esc` and `ctrl+g` at once, and other keys go
 * to the connection as soon as it exists.
 */
export function usePluginView({
  client,
  viewId,
  cols,
  rows,
  colorDepth,
  timing,
}: PluginViewOptions) {
  const [state, setState] = useState<PluginViewState>({
    phase: 'connecting',
    slow: false,
    frame: undefined,
    reason: undefined,
  })
  const [attempt, setAttempt] = useState(0)
  const connection = useRef<ViewConnection | undefined>(undefined)
  const size = useRef({ cols, rows })
  size.current = { cols, rows }
  const slowMs = timing?.slowMs ?? SLOW_LINK_MS
  const timeoutMs = timing?.timeoutMs ?? PENDING_TIMEOUT_MS

  useEffect(() => {
    // a new attempt starts from nothing; `attempt` is only here to re-run the effect
    void attempt
    setState({ phase: 'connecting', slow: false, frame: undefined, reason: undefined })
    // once this attempt timed out or ended, its late callbacks change nothing
    let settled = false
    const slowTimer = setTimeout(() => {
      if (!settled) setState((s) => (s.phase === 'connecting' ? { ...s, slow: true } : s))
    }, slowMs)
    let live: ViewConnection
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    try {
      live = client.openView({
        viewId,
        cols: size.current.cols,
        rows: size.current.rows,
        colorDepth,
        onFrame: (frame) => {
          if (!settled) setState((s) => (s.phase === 'ended' ? s : { ...s, phase: 'open', frame }))
        },
        onStatus: (status) => {
          if (!settled && status === 'open')
            setState((s) => (s.phase === 'connecting' ? { ...s, phase: 'open' } : s))
        },
        onEnd: (reason) => {
          if (!settled) {
            clearTimeout(timeoutTimer)
            setState((s) => ({ ...s, phase: 'ended', reason }))
          }
        },
      })
    } catch {
      // a client with no credential and no socket: nothing to open
      clearTimeout(slowTimer)
      setState({ phase: 'ended', slow: false, frame: undefined, reason: 'unavailable' })
      return undefined
    }
    connection.current = live
    timeoutTimer = setTimeout(() => {
      if (settled) return
      settled = true
      setState((s) =>
        s.phase === 'connecting'
          ? { phase: 'timeout', slow: true, frame: undefined, reason: undefined }
          : s,
      )
      connection.current = undefined
      live.close()
    }, timeoutMs)
    return () => {
      settled = true
      clearTimeout(slowTimer)
      clearTimeout(timeoutTimer)
      connection.current = undefined
      live.close()
    }
  }, [client, viewId, colorDepth, attempt, slowMs, timeoutMs])

  useEffect(() => {
    connection.current?.resize(cols, rows)
  }, [cols, rows])

  const sendKey = useCallback((data: string) => connection.current?.sendKey(data), [])
  const close = useCallback(() => connection.current?.close(), [])
  const reopen = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, sendKey, close, reopen }
}
