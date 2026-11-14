import { type Hint, Txt } from '@keith/ui'
import { Box, type Key, useInput } from 'ink'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import type { ConnectionState } from './use-connection.ts'

/** How long the `offline: ...` hint of a refused key stays on screen. */
export const OFFLINE_TOAST_MS = 3000

/**
 * The disconnected mode (tui-design 5.12): while the link to the core is `disconnected`, or
 * `reconnecting` after a drop, every screen that needs the core is inactive. A refused key says so.
 */
export interface Offline {
  /** `cannot reach the core (unix:~/.keith/core.sock, connection refused)`. */
  reason: string
  /** A key was refused: show `offline: <reason>` for a moment. */
  block(): void
  /** `r`: an attempt now (disconnected only, once per 3 s). */
  retry(): void
}

// The mode travels in a React context owned by the App (`LinkProvider`): an App that was never
// unmounted (a test) cannot leak a stale offline state into another one.
const LinkContext = createContext<Offline | undefined>(undefined)

/** Provides the offline mode (`useLinkValue`) to every screen below the App. */
export function LinkProvider({
  value,
  children,
}: {
  value: Offline | undefined
  children?: ReactNode
}) {
  return <LinkContext.Provider value={value}>{children}</LinkContext.Provider>
}

/** The offline mode, or `undefined` while the link is fine (or no provider is above). */
export const useLink = (): Offline | undefined => useContext(LinkContext)

/** The reason in words: what could not be reached and the last error. */
export function offlineReason(
  connection: Pick<ConnectionState, 'kind' | 'reason'>,
  target: string,
): string {
  const what = [target, connection.reason].filter((x) => x !== undefined && x !== '').join(', ')
  return `cannot reach the core${what === '' ? '' : ` (${what})`}`
}

/** The value `LinkProvider` carries: `undefined` while live, connecting or logged out. */
export function useLinkValue(
  connection: ConnectionState,
  target: string,
  say: (rows: string[]) => void,
  clear: () => void,
): Offline | undefined {
  const offline = connection.kind === 'disconnected' || connection.kind === 'reconnecting'
  const reason = offlineReason(connection, target)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryRef = useRef(connection.retry)
  retryRef.current = connection.retry
  const sayRef = useRef(say)
  sayRef.current = say
  const clearRef = useRef(clear)
  clearRef.current = clear
  const leave = useRef(() => {})
  leave.current = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }
  // no timer outlives the screen
  useEffect(() => () => leave.current(), [])
  const value = useMemo(() => {
    if (!offline) return undefined
    const toast = (rows: string[]): void => {
      sayRef.current(rows)
      leave.current()
      timer.current = setTimeout(() => clearRef.current(), OFFLINE_TOAST_MS)
    }
    return {
      reason,
      block: () => toast([`offline: ${reason} ${'·'} [r] retry now`]),
      retry: () => {
        if (!retryRef.current())
          toast([`offline: retrying already, or tried a moment ago ${'·'} [r] retry now`])
      },
    }
  }, [offline, reason])
  return value
}

/** A screen's legend while the core is gone: the keys that stay (esc, movement) as they are, the rest dimmed, `[r] retry now` added. */
export function offlineHints(hints: readonly Hint[]): readonly Hint[] {
  return [
    ...hints.map((h) => (STAY_KEYS.has(h.key) ? h : { ...h, dim: true })),
    { key: 'r', action: 'retry now', priority: 95 },
  ]
}
const STAY_KEYS = new Set(['esc', 'ctrl+g', 'ctrl+c', '↑↓', '↑', '↓', '←→'])

/** Keys that stay alive offline: quit, leave, move through what is already loaded. */
const stays = (input: string, key: Key): boolean =>
  (key.ctrl && (input === 'c' || input === 'g')) ||
  key.escape ||
  key.upArrow ||
  key.downArrow ||
  key.leftArrow ||
  key.rightArrow ||
  key.pageUp ||
  key.pageDown

/**
 * `useInput` for a screen that needs the core: offline, only `ctrl+c`, `ctrl+g`, `esc` and the
 * movement keys reach `handler`; `r` is the retry key; anything else is refused with the one-line
 * `offline:` hint instead of failing quietly.
 */
export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options?: {
    isActive?: boolean
    /** A key that still works offline (Home's Logout: ending a session needs no core). */
    allow?: (input: string, key: Key) => boolean
  },
): void {
  const offline = useLink()
  const { allow, ...rest } = options ?? {}
  useInput((input, key) => {
    if (offline === undefined || stays(input, key) || allow?.(input, key) === true)
      return handler(input, key)
    if (input === 'r') return
    offline.block()
  }, rest)
}

/** Mounted once: `r` starts an attempt now while offline. */
export function OfflineKeys() {
  const offline = useLink()
  useInput(
    (input, key) => {
      if (input === 'r' && !key.ctrl && !key.meta) offline?.retry()
    },
    { isActive: offline !== undefined },
  )
  return null
}

/** The chat's input row while offline: the message instead of the placeholder (the draft is kept in the chat). */
export function offlineBar(reason: string): ReactNode {
  // the address and the last error are in the title row; the bar keeps the keys readable on a narrow column
  const short = reason.replace(/\s*\(.*\)$/, '')
  return (
    <Box paddingLeft={2}>
      <Txt tone="danger" wrap="truncate-end">
        {`✕ offline: ${short} · [r] retry now · your draft is kept`}
      </Txt>
    </Box>
  )
}
