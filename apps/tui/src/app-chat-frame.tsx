import { type StatusInfo, StatusLine } from '@keith/ui'
import { Box } from 'ink'
import type { ReactNode } from 'react'

export interface ChatFrameProps {
  width: number
  rows: number
  /** Another screen is on top (Home, a framed screen, the flight): the chat stays mounted but draws nothing. */
  hidden: boolean
  headerOn: boolean
  /** The header sits inside the chat view (beside the sidebar). */
  headInChat: boolean
  /** The chat header for the full width. */
  header: ReactNode
  status: StatusInfo
  /** The blank row under the legend (0 on a short terminal). */
  margin: number
  main: ReactNode
  /** The sidebar, when it sits beside `main` here rather than inside the chat view. */
  sidebar: ReactNode
  /** The room banner row, under the header (undefined without a room). */
  banner?: ReactNode
}

/** The chat screen: blank top row, header or status line, the chat column (and the sidebar), the bottom margin. */
export function ChatFrame(p: ChatFrameProps) {
  return (
    <Box
      flexDirection="column"
      width={p.width}
      height={p.rows}
      {...(p.hidden ? { display: 'none' as const } : {})}
    >
      {/* the same one blank row on top as every screen */}
      {p.headerOn && <Box height={1} flexShrink={0} />}
      {p.headInChat ? null : p.headerOn ? (
        p.header
      ) : (
        <>
          <Box height={1} flexShrink={0} />
          <StatusLine width={p.width} status={p.status} />
          <Box height={1} flexShrink={0} />
        </>
      )}
      {p.banner}
      <Box flexGrow={1} flexShrink={1}>
        {p.main}
        {p.sidebar}
      </Box>
      {p.margin > 0 && <Box height={1} flexShrink={0} />}
    </Box>
  )
}
