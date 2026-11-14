import { Box, Text, useWindowSize } from 'ink'
import { BrainFrame } from './brain-frame.tsx'
import {
  ConnectionWord,
  connectionTone,
  Elevated,
  type StatusInfo,
  TitleAlert,
  titleAlertOf,
} from './connection-mark.tsx'
import type { BrainTrace } from './orb/brain-trace.ts'
import type { OrbMode } from './orb/orb.ts'
import { OrbCanvas } from './orb-canvas.tsx'
import { PulseGlyph } from './pulse-glyph.tsx'
import { Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'
import { type FrameClock, useFrameClock } from './use-frame-clock.ts'
import { useNow } from './use-now.ts'
import { alertLinesOf } from './wrap-lines.ts'

/** The mini orb of the chat header, in cells. */
export const CHAT_ORB_WIDTH = 14
export const CHAT_ORB_HEIGHT = 7
/** Rows of the header: the blank and the title over the Brain frame's six region rows and its trail (the orb is 7). */
export const CHAT_HEADER_ROWS = 9
/** Rows of the title-only header (the orb is in the sidebar): the title row and a blank row. */
export const CHAT_TITLE_ROWS = 2
/** Columns left of the orb, and between the orb and the text. */
export const CHAT_HEADER_LEFT = 2
const TEXT_GAP = 2
/** A header needs this many columns; below it the app shows the status line. */
export const CHAT_HEADER_MIN_COLUMNS = 80

interface TitleRowProps {
  mode: OrbMode
  width: number
  running: boolean
  status: StatusInfo | undefined
}

/** `✳ KEITH  <mode>`, the elevated countdown at the far end; a down link's message is drawn under the row by the header. */
function TitleRow({ mode, width, running, status }: TitleRowProps) {
  return (
    <Box width={width} height={1}>
      <Box flexShrink={0}>
        <PulseGlyph
          {...(status === undefined ? { mode } : { tone: connectionTone(status.connection) })}
          running={running}
        />
        <Text> </Text>
        <Txt bold>KEITH</Txt>
        <Txt tone="muted">{`  ${mode}`}</Txt>
        {status !== undefined && (
          <>
            <Text> </Text>
            <ConnectionWord
              kind={status.connection}
              {...(status.target === undefined ? {} : { target: status.target })}
              {...(status.disconnect === undefined ? {} : { disconnect: status.disconnect })}
              {...(status.reconnectUntil === undefined
                ? {}
                : { reconnectUntil: status.reconnectUntil })}
            />
          </>
        )}
      </Box>
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" marginLeft={2}>
        {status?.elevatedUntil !== undefined && <Elevated until={status.elevatedUntil} />}
      </Box>
    </Box>
  )
}

export interface ChatHeaderProps {
  /** `orb` (default): the mini orb, the facts and the brain rows; `title`: the title row alone, the orb lives elsewhere. */
  variant?: 'orb' | 'title'
  mode: OrbMode
  /** Cell width over cell height (default 0.5). */
  cellAspect?: number
  trace: BrainTrace
  /** The whole row, in cells. */
  width: number
  /** `false` stops the timers (the chat is not on screen). */
  running?: boolean
  /** A clock shared with other animations; the header has its own when omitted. */
  clock?: FrameClock
  /** The connection (the colour of the `✳`, a word when not online) and the elevated countdown at the right. */
  status?: StatusInfo
  fps?: number
}

/**
 * The chat's header (tui-design 5.17): the mini orb on the left; to its right a title row
 * `✳ KEITH  <mode>` with `right` at the far end, the brain graph and region list, and the trail
 * of recent regions. Always `CHAT_HEADER_ROWS` rows high. The `title` variant (wide terminals, the
 * orb and the graph are in the sidebar) is the title row and a blank one: `CHAT_TITLE_ROWS`.
 */
export function ChatHeader({
  variant = 'orb',
  mode,
  cellAspect,
  trace,
  width,
  running = true,
  clock,
  status,
  fps = 12,
}: ChatHeaderProps) {
  const theme = useTheme()
  const own = useFrameClock({ fps: theme.depth === 'none' ? 2 : fps, running: running && !clock })
  const shared = clock ?? own
  const { rows: terminalRows } = useWindowSize()
  const now = useNow(status?.connection === 'disconnected')
  if (variant === 'title') {
    const titleWidth = Math.max(10, width - CHAT_HEADER_LEFT * 2)
    const alert = titleAlertOf(status, titleWidth, alertLinesOf(terminalRows), now)
    return (
      <Box
        width={width}
        height={CHAT_TITLE_ROWS + alert.length}
        flexShrink={0}
        flexDirection="column"
        paddingLeft={CHAT_HEADER_LEFT}
      >
        <TitleRow mode={mode} width={titleWidth} running={running} status={status} />
        {alert.length > 0 && <TitleAlert lines={alert} />}
      </Box>
    )
  }
  const textWidth = Math.max(10, width - CHAT_HEADER_LEFT * 2 - CHAT_ORB_WIDTH - TEXT_GAP)
  const alert = titleAlertOf(status, textWidth, alertLinesOf(terminalRows), now)
  return (
    <Box
      width={width}
      height={CHAT_HEADER_ROWS + alert.length}
      flexShrink={0}
      paddingLeft={CHAT_HEADER_LEFT}
    >
      <OrbCanvas
        mode={mode}
        width={CHAT_ORB_WIDTH}
        height={CHAT_ORB_HEIGHT}
        {...(cellAspect === undefined ? {} : { cellAspect })}
        running={running}
        clock={shared}
      />
      <Box flexDirection="column" marginLeft={TEXT_GAP} width={textWidth} flexShrink={0}>
        <Box height={1} />
        <TitleRow mode={mode} width={textWidth} running={running} status={status} />
        {alert.length > 0 && <TitleAlert lines={alert} />}
        <BrainFrame
          bare
          trace={trace}
          width={textWidth}
          status={mode}
          graphRows={4}
          running={running}
          clock={shared}
        />
      </Box>
    </Box>
  )
}
