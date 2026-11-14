import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { hexToRgb } from './orb/color.ts'
import { frame, frameStyle, type Tag } from './orb/frame-text.ts'
import { PALETTES, type Token } from './theme.ts'
import { useTheme } from './theme-context.tsx'
import { useOrbPalette } from './use-orb-palette.ts'

export type { Tag as FrameTag }

export interface FramePanelProps {
  /** Cells, borders included (at least 2). */
  width: number
  /** Tags set into the top border, left to right (`{ text, hot }`: `hot` paints the first letter in the accent). */
  top?: readonly Tag[]
  topRight?: readonly Tag[]
  center?: string
  bottom?: readonly Tag[]
  /** The border and the tags take this status colour (a dialog that has the keys, a problem block). */
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'accent'
  /** Body rows as strings (may carry colour escapes from `@keith/ui` helpers); clipped to the inner width. */
  lines?: readonly string[]
  /** Or body rows as elements, laid out in `width - 2` columns between `│` sides. */
  children?: ReactNode
  /** Columns of space between a side and the children (default 0). */
  padX?: number
  /** Children mode: the frame takes the height its parent gives it, the bottom edge at the bottom. */
  grow?: boolean
}

const SIDES = {
  topLeft: '',
  top: '',
  topRight: '',
  left: '│',
  bottomLeft: '',
  bottom: '',
  bottomRight: '',
  right: '│',
} as const

/**
 * The one frame of the app (tui-design 5.18): `╭─ tag ─╮` rounded corners, tags set into the
 * border, rows of exactly `width` cells. Panels, dialogs, blocks and detail panes all draw through it.
 */
export function FramePanel({
  width,
  top,
  topRight,
  center,
  bottom,
  tone,
  lines,
  children,
  padX = 0,
  grow = false,
}: FramePanelProps) {
  const palette = useOrbPalette()
  const theme = useTheme()
  const colors = tone === undefined ? palette.frame : toned(palette.frame, theme.name, tone)
  const style = frameStyle(colors, palette.env.depth)
  const options = { width, style, top, center, topRight, bottom, body: lines ?? [] }
  const rows = frame(options)
  if (lines !== undefined || children === undefined) {
    return (
      <Box width={width} flexDirection="column">
        {rows.map((row, i) => (
          <Text key={i} wrap="truncate">
            {row}
          </Text>
        ))}
      </Box>
    )
  }
  const edges = frame({ ...options, body: [] })
  const sideColor = theme.color(tone ?? 'border')
  const side = sideColor === undefined ? {} : { borderColor: sideColor }
  return (
    <Box width={width} flexDirection="column" {...(grow ? { flexGrow: 1 } : {})}>
      <Text wrap="truncate">{edges[0]}</Text>
      <Box
        width={width}
        flexDirection="column"
        borderStyle={SIDES}
        borderTop={false}
        borderBottom={false}
        paddingX={padX}
        {...(grow ? { flexGrow: 1 } : {})}
        {...side}
      >
        {children}
      </Box>
      <Text wrap="truncate">{edges[1]}</Text>
    </Box>
  )
}

function toned(
  base: ReturnType<typeof useOrbPalette>['frame'],
  theme: 'dark' | 'light',
  tone: Token,
) {
  const rgb = hexToRgb(PALETTES[theme][tone].hex)
  return { ...base, border: rgb, text: rgb }
}
