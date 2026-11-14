import { Box } from 'ink'
import type { ReactNode } from 'react'
import { Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'

/** Columns the brackets and their padding take: `[ ` and ` ]`. */
export const BRACKET_COLUMNS = 4

/**
 * A one-row input field: the content between a dim `[` and `]` on the `user-message` fill (the fill
 * is the only background the language allows besides the message bubble; without colour it is just
 * the brackets). `width` is the whole box; the content gets `width - BRACKET_COLUMNS` columns.
 */
export function BracketBox({ width, children }: { width: number; children: ReactNode }) {
  const theme = useTheme()
  return (
    <Box width={width} height={1} flexShrink={0} {...theme.bg('user-message')}>
      <Txt tone="muted">{'[ '}</Txt>
      <Box width={Math.max(1, width - BRACKET_COLUMNS)} flexShrink={0} overflow="hidden">
        {children}
      </Box>
      <Txt tone="muted">{' ]'}</Txt>
    </Box>
  )
}
