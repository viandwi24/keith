import { Box } from 'ink'
import type { ReactNode } from 'react'
import { FramePanel } from './frame-panel.tsx'

export interface TwoPaneProps {
  /** The narrow pane on the left (a section list). */
  side: ReactNode
  sideWidth: number
  width: number
  /** The label in the top border of the detail frame (the current section). */
  label?: string
  /** The count in the right tag of the detail frame (`2/8`). */
  count?: string
  /** `false`: the right pane draws its own frame (or a dialog); the children get the whole pane. Default true. */
  framed?: boolean
  /** The wide pane on the right, inside its frame. */
  children?: ReactNode
}

/**
 * A navigation pane and a framed detail pane side by side. The side pane is plain rows (the
 * current one marked); the detail is a `FramePanel` that takes the height left.
 */
export function TwoPane({
  side,
  sideWidth,
  width,
  label,
  count,
  framed = true,
  children,
}: TwoPaneProps) {
  return (
    <Box width={width} flexGrow={1} flexShrink={1}>
      <Box width={sideWidth} flexShrink={0} flexDirection="column">
        {side}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={1}>
        {framed ? (
          <FramePanel
            width={Math.max(4, width - sideWidth - 1)}
            {...(label === undefined ? {} : { top: [{ text: label }] })}
            {...(count === undefined ? {} : { topRight: [{ text: count }] })}
            padX={1}
            grow
          >
            {children}
          </FramePanel>
        ) : (
          children
        )}
      </Box>
    </Box>
  )
}
