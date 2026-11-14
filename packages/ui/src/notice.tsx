import { Box } from 'ink'
import { G } from './glyphs.ts'
import { Rich } from './rich-text.tsx'
import { INDENT } from './spacing.ts'
import { Txt } from './text.tsx'

export type NoticeLevel = 'info' | 'warning' | 'error'

const TONE = { info: 'info', warning: 'warning', error: 'danger' } as const

/** The glyph that leads a notice (and carries its meaning where colour is off). */
const GLYPH = { info: G.sep, warning: G.warn, error: G.failed } as const

export interface NoticeProps {
  level: NoticeLevel
  /** One string per row; commands in backticks or `/word` form are drawn in `accent`. */
  rows: readonly string[]
}

/** A conversation row led by a glyph in its tone (`·` info, `!` warning, `✕` error); continuation rows are indented under the text. */
export function Notice({ level, rows }: NoticeProps) {
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          <Box flexShrink={0} width={INDENT}>
            {i === 0 && (
              <Txt bold tone={TONE[level]}>
                {GLYPH[level]}
              </Txt>
            )}
          </Box>
          <Box flexShrink={1}>
            <Rich text={row} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
