import { Box, Text } from 'ink'
import { useTheme } from './theme-context.tsx'

/** One styled stretch of text of an outside source (a plugin view): the colours are data, never tokens. */
export interface StyledRun {
  text: string
  /** `#rrggbb`, `ansi256(n)` or a colour name Ink knows; ignored when the theme has no colour. */
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strike?: boolean
}

export interface StyledLinesProps {
  lines: readonly (readonly StyledRun[])[]
  width: number
  /** Rows to fill: the lines are cut to it and shorter ones are padded with blank rows. */
  height: number
}

/**
 * Lines of styled runs in a fixed box, one terminal row each, cut at `width` (never wrapped). It is the one place a
 * colour that did not come from the theme reaches the screen: the runs are the client's already-sanitised frame of a
 * plugin view (no escape can be in them), drawn with Ink's own `Text`. With no colour (`NO_COLOR`) every colour is
 * dropped and the attributes stay.
 */
export function StyledLines({ lines, width, height }: StyledLinesProps) {
  const colour = useTheme().depth !== 'none'
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {Array.from({ length: height }, (_, row) => {
        const runs = lines[row] ?? []
        return (
          <Box key={row} width={width} height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate">
              {runs.length === 0
                ? ' '
                : runs.map((run, i) => (
                    <Text
                      key={i}
                      {...(colour && run.fg !== undefined ? { color: run.fg } : {})}
                      {...(colour && run.bg !== undefined ? { backgroundColor: run.bg } : {})}
                      {...(run.bold === true ? { bold: true } : {})}
                      {...(run.dim === true ? { dimColor: true } : {})}
                      {...(run.italic === true ? { italic: true } : {})}
                      {...(run.underline === true ? { underline: true } : {})}
                      {...(run.inverse === true ? { inverse: true } : {})}
                      {...(run.strike === true ? { strikethrough: true } : {})}
                    >
                      {run.text}
                    </Text>
                  ))}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
