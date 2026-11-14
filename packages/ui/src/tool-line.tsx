import { Box, Text } from 'ink'
import { G } from './glyphs.ts'
import { PulseGlyph } from './pulse-glyph.tsx'
import { type Tone, Txt } from './text.tsx'

export interface ToolState {
  /** `✓ 0.4s`, `✕ exit 1`, `waiting for approval`, `00:42`. */
  text: string
  tone: Tone
  /** A running call shows the pulsing glyph before the text. */
  spinner?: boolean
}

export interface ToolLineProps {
  /** `›` for a tool call, or a task status glyph for a delegated task. */
  glyph: string
  glyphTone?: Tone
  /** Node or agent: `laptop-e`, `research`, `memory.recall`. */
  label: string
  /** One-line summary of the input: `$ df -h`. */
  summary?: string
  state?: ToolState
  /** At most 3 output lines, each under a `│` gutter. */
  output?: readonly string[]
  /** `… n more lines` after the output. */
  more?: number
}

/** One tool call or delegated task: never wraps, truncates with `…`, output under a gutter. */
export function ToolLine({
  glyph,
  glyphTone = 'tool',
  label,
  summary,
  state,
  output = [],
  more = 0,
}: ToolLineProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Txt tone={glyphTone}>{glyph} </Txt>
            <Txt tone="tool">{label}</Txt>
            {summary !== undefined && summary !== '' && <Txt tone="tool"> {summary}</Txt>}
          </Text>
        </Box>
        {state !== undefined && (
          <Box flexShrink={0} marginLeft={2}>
            {state.spinner === true && (
              <>
                <PulseGlyph tone="accent" />
                <Text> </Text>
              </>
            )}
            <Txt tone={state.tone}>{state.text}</Txt>
          </Box>
        )}
      </Box>
      {output.map((line, i) => (
        <Box key={i}>
          <Box flexShrink={0}>
            <Txt tone="muted">{G.rule} </Txt>
          </Box>
          <Txt tone="tool" wrap="truncate-end">
            {line}
          </Txt>
        </Box>
      ))}
      {more > 0 && (
        <Box>
          <Box flexShrink={0}>
            <Txt tone="muted">{G.rule} </Txt>
          </Box>
          <Txt tone="muted">
            {G.ellipsis} {more} more {more === 1 ? 'line' : 'lines'}
          </Txt>
        </Box>
      )}
    </Box>
  )
}
