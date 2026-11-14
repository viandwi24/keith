import { Box, Text } from 'ink'
import { useRef } from 'react'
import { centerRow, subtitleRows } from './orb/subtitle.ts'
import { Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'
import { type FrameClock, useFrameClock } from './use-frame-clock.ts'

export interface SubtitleProps {
  /** What Keith is saying: grows while a reply streams, is replaced by a new one, `''` clears it. */
  text: string
  /** Cells the rows are centred in; the text wraps at `min(width, maxWidth)`. */
  width: number
  maxWidth?: number
  /** Rows kept (the newest), default 2. The component always takes this many rows, so nothing jumps. */
  maxRows?: number
  /** Characters typed out per second (default 90). */
  cps?: number
  running?: boolean
  clock?: FrameClock
}

const CATCH_UP = 60 // behind by more than this many characters: type faster

/** The words under the orb, centred, typed out as `text` arrives. No animation in `none` depth. */
export function Subtitle({
  text,
  width,
  maxWidth = 76,
  maxRows = 2,
  cps = 90,
  running = true,
  clock,
}: SubtitleProps) {
  const theme = useTheme()
  const chars = [...text]
  const typed = useRef({ text: '', shown: 0, tick: -1 })
  const st = typed.current
  const animated = theme.depth !== 'none' && running
  // a text that continues the last one keeps its progress; any other restarts the typing
  if (st.text !== text) {
    if (!text.startsWith(st.text)) st.shown = 0
    st.text = text
  }
  const behind = chars.length - st.shown > 0
  const own = useFrameClock({ running: animated && behind && !clock })
  const { tick, dt } = clock ?? own
  if (!animated) st.shown = chars.length
  else if (tick !== st.tick) {
    st.tick = tick
    const rate = chars.length - st.shown > CATCH_UP ? cps * 3 : cps
    st.shown = Math.min(chars.length, st.shown + Math.max(1, Math.ceil(dt * rate)))
  }
  const rows = subtitleRows(chars.slice(0, st.shown).join(''), Math.min(width, maxWidth), maxRows)
  return (
    <Box width={width} height={maxRows} flexDirection="column">
      {Array.from({ length: maxRows }, (_, i) => (
        <Text key={i} wrap="truncate">
          <Txt>{centerRow(rows[i] ?? '', width)}</Txt>
        </Text>
      ))}
    </Box>
  )
}
