import { Box } from 'ink'
import type { ReactNode } from 'react'
import type { StatusInfo } from './connection-mark.tsx'
import { type FooterContent, LegendRow } from './footer.tsx'
import { GUTTER } from './spacing.ts'
import { TitleRow } from './title-row.tsx'

export interface ScreenFrameProps {
  /** Cells of the whole screen. */
  width: number
  /** Rows of the whole screen; without it the frame takes the height its parent gives it. */
  height?: number
  /** The screen label in the corner tag of the title row (` Manage `, ` Tasks `). */
  label?: string
  /** The connection and countdown of the title row. */
  status?: StatusInfo
  /** The one legend of the screen, at the bottom (hints dropped by priority to fit, or a sentence). */
  legend?: FooterContent
  children?: ReactNode
}

/** Rows the frame itself takes: top margin, title row, a gap, a blank above the legend, the legend, bottom margin. */
export const SCREEN_CHROME_ROWS = 6

/**
 * A full screen of the app (tui-design 5.18): one blank row on top, the title row (`K E I T H`
 * centred, the label tag on the left, the status on the right), a gap, the content in a 2-column
 * margin, a blank row, the legend and one blank row at the bottom. Children get `width - 2` columns
 * and `height - SCREEN_CHROME_ROWS` rows.
 */
export function ScreenFrame({ width, height, label, status, legend, children }: ScreenFrameProps) {
  return (
    <Box
      flexDirection="column"
      width={width}
      {...(height === undefined ? { flexGrow: 1 } : { height })}
      flexShrink={1}
    >
      <Box height={1} flexShrink={0} />
      <TitleRow
        width={width}
        {...(label === undefined ? {} : { label })}
        {...(status === undefined ? {} : { status })}
      />
      <Box height={1} flexShrink={0} />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        paddingLeft={GUTTER}
      >
        {children}
      </Box>
      {legend !== undefined && (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={GUTTER} flexShrink={0}>
            <LegendRow content={legend} width={Math.max(1, width - GUTTER * 2)} />
          </Box>
        </>
      )}
      <Box height={1} flexShrink={0} />
    </Box>
  )
}
