import { Box } from 'ink'
import type { ReactNode } from 'react'
import { G } from './glyphs.ts'
import { PulseGlyph } from './pulse-glyph.tsx'
import { type Tone, Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'
import { useNow } from './use-now.ts'
import { wrapLines } from './wrap-lines.ts'

export type ConnectionKind =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected'
  | 'logged-out'
  | 'offline'

/** `disconnected`: when the next attempt starts, what could not be reached and the last error. */
export interface DisconnectInfo {
  /** Epoch ms of the next attempt: the message counts down to it. */
  retryAt: number
  /** The core's address (`unix:~/.keith/core.sock` or the URL). */
  target?: string
  /** The last error in words (`connection refused`, `timeout`, `the core answered 503`). */
  reason?: string
}

/** What a title row shows about the session: the connection (the glyph's colour) and the countdown. */
export interface StatusInfo {
  connection: ConnectionKind
  /** What the first connect is trying: `unix:~/.keith/core.sock` or the URL. */
  target?: string
  /** Set with `disconnected`: the message and its countdown. */
  disconnect?: DisconnectInfo
  /** Set with `reconnecting`: epoch ms when the attempt's window ends (`reconnecting… (3 s)`). */
  reconnectUntil?: number
  /** Epoch ms until which the session is stepped up: `elevated 9:41` counts down at the right. */
  elevatedUntil?: number
}

/** The colour of the `✳` glyph: green online, yellow while (re)connecting, red offline or logged out. */
export function connectionTone(kind: ConnectionKind): Tone {
  if (kind === 'live') return 'success'
  if (kind === 'connecting' || kind === 'reconnecting') return 'warning'
  return 'danger' // disconnected, offline, logged out
}

const WORD: Record<ConnectionKind, string> = {
  live: 'online',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
  'logged-out': 'logged out',
  offline: 'offline',
}

/** The word next to the title: only without colour (the glyph's colour says it otherwise). */
export function connectionWord(kind: ConnectionKind, colour: boolean): string | undefined {
  return colour ? undefined : WORD[kind]
}

/** Seconds until `at`, rounded up, never below 0. */
export const secondsUntil = (at: number, now: number): number =>
  Math.max(0, Math.ceil((at - now) / 1000))

/**
 * The message of a down link: `✕ disconnected: cannot reach the core (<target>, <reason>) · retrying in 12 s`; without a
 * reason or a target the parenthesis is left out. It is wrapped under the title row (`titleAlertOf`), never cut.
 */
export function disconnectedText(info: DisconnectInfo, left: number): string {
  const tail = `${G.sep} retrying in ${left} s`
  const what = [info.target, info.reason].filter((x) => x !== undefined).join(', ')
  return what === ''
    ? `${G.failed} disconnected: cannot reach the core ${tail}`
    : `${G.failed} disconnected: cannot reach the core (${what}) ${tail}`
}

/**
 * The rows of the top alert under the title row (tui-design 5.2): the disconnected message, wrapped on words to `width` cells and
 * at most `maxLines` rows (its end then ends with `…`). Continuation rows are indented two cells, under the text after the glyph.
 * Empty for every other state. Pure: `now` is the clock of the countdown.
 */
export function titleAlertOf(
  status: StatusInfo | undefined,
  width: number,
  maxLines: number,
  now: number,
): string[] {
  if (status?.connection !== 'disconnected' || status.disconnect === undefined) return []
  const text = disconnectedText(status.disconnect, secondsUntil(status.disconnect.retryAt, now))
  const rows = wrapLines(text, Math.max(1, width - 2), maxLines)
  return rows.map((row, i) => (i === 0 ? row : `  ${row}`))
}

/** The rows of a top alert under a title row: the first in the alert colour, the rest as the rows already are. */
export function TitleAlert({ lines }: { lines: readonly string[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Txt key={i} tone="danger">
          {line}
        </Txt>
      ))}
    </Box>
  )
}

/** `reconnecting… (3 s)`: the attempt's window. */
function Reconnecting({ until }: { until: number }) {
  const now = useNow(true)
  return <Txt tone="warning">{` reconnecting… (${secondsUntil(until, now)} s)`}</Txt>
}

/**
 * The word after the title: only without colour (the glyph's colour says it otherwise). A `disconnected` link with its
 * details has no word here: its message is the top alert under the title (`titleAlertOf`).
 */
export function ConnectionWord({
  kind,
  target,
  disconnect,
  reconnectUntil,
}: {
  kind: ConnectionKind
  target?: string
  disconnect?: DisconnectInfo
  reconnectUntil?: number
}) {
  const theme = useTheme()
  if (kind === 'reconnecting' && reconnectUntil !== undefined) {
    return <Reconnecting until={reconnectUntil} />
  }
  if (kind === 'disconnected' && disconnect !== undefined) return null
  const word = connectionWord(kind, theme.depth !== 'none')
  if (word === undefined) return null
  return (
    <>
      <Txt tone={connectionTone(kind)}>{` ${word}`}</Txt>
      {kind === 'connecting' && target !== undefined && <Txt tone="muted">{` ${target}`}</Txt>}
    </>
  )
}

/** The glyph alone, then the word when there is one: the connection at the end of a row. */
export function ConnectionMark({ status }: { status: StatusInfo }) {
  return (
    <>
      <PulseGlyph tone={connectionTone(status.connection)} />
      <ConnectionWord
        kind={status.connection}
        {...(status.target === undefined ? {} : { target: status.target })}
        {...(status.disconnect === undefined ? {} : { disconnect: status.disconnect })}
        {...(status.reconnectUntil === undefined ? {} : { reconnectUntil: status.reconnectUntil })}
      />
    </>
  )
}

/** The title with the glyph before it and the word after it: `✳ K E I T H  offline`. */
export function TitleMark({
  status,
  children,
}: {
  status: StatusInfo | undefined
  children: ReactNode
}) {
  return (
    <>
      {status !== undefined && (
        <>
          <PulseGlyph tone={connectionTone(status.connection)} />
          <Txt> </Txt>
        </>
      )}
      {children}
      {status !== undefined && (
        <ConnectionWord
          kind={status.connection}
          {...(status.target === undefined ? {} : { target: status.target })}
          {...(status.disconnect === undefined ? {} : { disconnect: status.disconnect })}
          {...(status.reconnectUntil === undefined
            ? {}
            : { reconnectUntil: status.reconnectUntil })}
        />
      )}
    </>
  )
}

/** `elevated 9:41`, ticking each second; nothing once it ran out. Its own component: only it re-renders. */
export function Elevated({ until }: { until: number }) {
  const now = useNow(true)
  const left = until - now
  if (left <= 0) return null
  const total = Math.ceil(left / 1000)
  const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  return (
    <Box flexShrink={0}>
      <Txt tone="muted">{`elevated ${clock}`}</Txt>
    </Box>
  )
}
