import { Box } from 'ink'
import type { ReactNode } from 'react'
import { G } from './glyphs.ts'
import { PulseGlyph } from './pulse-glyph.tsx'
import { safeChildren } from './safe-text.ts'
import { GUTTER, INDENT } from './spacing.ts'
import { Txt } from './text.tsx'
import { useTheme } from './theme-context.tsx'

export interface MessageProps {
  kind: 'user' | 'assistant' | 'proactive'
  /** The answer is still coming: the dot is the pulsing glyph. */
  streaming?: boolean
  /** Width of the conversation column. */
  width: number
  children?: ReactNode
}

/**
 * One conversation message. User: an accent `›` and the text on the `user-message` fill, which
 * spans the whole column (gutter included; the only painted thing in the app, no fill in `16` and
 * `none` depth). The rest is nothing painted. Assistant: an
 * accent `●` (the pulsing glyph while streaming), the body indented by 2. Proactive: the dot is
 * `◆` in `info`.
 */
export function Message({ kind, streaming = false, width, children }: MessageProps) {
  const theme = useTheme()
  if (kind === 'user') {
    return (
      <Box width={width} paddingLeft={GUTTER} {...theme.bg('user-message')}>
        <Box flexShrink={0} width={INDENT}>
          <Txt tone="accent" bold>
            {G.prompt}
          </Txt>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {safeChildren(children)}
        </Box>
      </Box>
    )
  }
  return (
    <Box width={width} paddingLeft={GUTTER}>
      <Box flexShrink={0} width={INDENT}>
        {streaming ? (
          <PulseGlyph tone="accent" />
        ) : kind === 'proactive' ? (
          <Txt tone="info">{G.proactive}</Txt>
        ) : (
          <Txt tone="accent">{G.dot}</Txt>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {safeChildren(children)}
      </Box>
    </Box>
  )
}
