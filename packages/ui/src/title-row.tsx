import { Box, Text, useWindowSize } from 'ink'
import {
  Elevated,
  type StatusInfo,
  TitleAlert,
  TitleMark,
  titleAlertOf,
} from './connection-mark.tsx'
import { frame, frameStyle } from './orb/frame-text.ts'
import { GUTTER } from './spacing.ts'
import { Txt } from './text.tsx'
import { cells } from './text-width.ts'
import { useNow } from './use-now.ts'
import { useOrbPalette } from './use-orb-palette.ts'
import { alertLinesOf } from './wrap-lines.ts'

/** The letter-spaced name centred on the title row of every full screen. */
export const TITLE_TEXT = 'K E I T H'

export interface TitleRowProps {
  /** Cells of the whole row, margins included. */
  width: number
  /** The screen label, drawn as a small frame tag on the left (`╭─ Manage ─╮`). */
  label?: string
  /** The connection (the colour of the `✳` before the name, a word when not online) and the elevated countdown at the right. */
  status?: StatusInfo
}

/** `╭─ Manage ─╮`: the label of a screen in the corner of a frame, one row, like the Home frame's tag. */
function LabelTag({ label }: { label: string }) {
  const palette = useOrbPalette()
  const style = frameStyle(palette.frame, palette.env.depth)
  const [row] = frame({ width: cells(label) + 6, style, top: [{ text: label }], body: [] })
  return <Text wrap="truncate">{row}</Text>
}

/**
 * The title row of a screen (tui-design 5.18): the label tag on the left, `K E I T H` centred
 * inside the margins, the status at the right. One row, absolutely laid so the name is truly centred.
 * A down link adds its message below the row (tui-design 5.2): 1 to 4 rows, the content below moves down.
 */
export function TitleRow({ width, label, status }: TitleRowProps) {
  // the tag gives way to the centred name on a row too narrow for both
  const titleStart = GUTTER + Math.floor((width - GUTTER * 2 - cells(TITLE_TEXT)) / 2)
  const showLabel = label !== undefined && GUTTER + cells(label) + 6 < titleStart
  const { rows } = useWindowSize()
  const now = useNow(status?.connection === 'disconnected')
  const alert = titleAlertOf(status, Math.max(10, width - GUTTER * 2), alertLinesOf(rows), now)
  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      <Box height={1} flexShrink={0}>
        {showLabel && label !== undefined && (
          <Box position="absolute" top={0} left={GUTTER}>
            <LabelTag label={label} />
          </Box>
        )}
        <Box
          position="absolute"
          top={0}
          left={GUTTER}
          width={Math.max(1, width - GUTTER * 2)}
          justifyContent="center"
        >
          <TitleMark status={status}>
            <Txt bold>{TITLE_TEXT}</Txt>
          </TitleMark>
        </Box>
        {status?.elevatedUntil !== undefined && (
          <Box position="absolute" top={0} right={GUTTER}>
            <Elevated until={status.elevatedUntil} />
          </Box>
        )}
      </Box>
      {alert.length > 0 && (
        <Box paddingLeft={GUTTER} width={width}>
          <TitleAlert lines={alert} />
        </Box>
      )}
    </Box>
  )
}
