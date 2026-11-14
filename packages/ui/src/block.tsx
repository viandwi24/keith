import { Box } from 'ink'
import { FramePanel } from './frame-panel.tsx'
import { Rich } from './rich-text.tsx'
import { GUTTER } from './spacing.ts'
import type { Tone } from './text.tsx'

export interface BlockRow {
  text: string
  tone?: Tone
}

export interface BlockProps {
  /** The frame colour: `danger`, `warning` or `info`. */
  level: 'danger' | 'warning' | 'info'
  width: number
  rows: readonly BlockRow[]
  /** The label in the top border (default by level: `Problem`, `Notice`, `Info`). */
  title?: string
}

const TITLE = { danger: 'Problem', warning: 'Notice', info: 'Info' } as const

/**
 * A framed block with rows in their own tones (the logged-out block, the core-down block): a
 * `FramePanel` in the level's colour with its label in the top border.
 */
export function Block({ level, width, rows, title = TITLE[level] }: BlockProps) {
  return (
    <Box width={width} paddingLeft={GUTTER}>
      <FramePanel width={Math.max(2, width - GUTTER)} top={[{ text: title }]} tone={level} padX={1}>
        {rows.map((row, i) => (
          <Rich key={i} text={row.text} {...(row.tone === undefined ? {} : { tone: row.tone })} />
        ))}
      </FramePanel>
    </Box>
  )
}
