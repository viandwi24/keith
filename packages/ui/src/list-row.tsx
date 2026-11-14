import { Box } from 'ink'
import type { ReactNode } from 'react'
import { G } from './glyphs.ts'
import { stripControl } from './safe-text.ts'
import { type Tone, Txt } from './text.tsx'

export interface Column {
  text: ReactNode | string
  /** Fixed width in cells; without it the column is as wide as the row allows (`flex`). */
  width?: number
  flex?: boolean
  tone?: Tone
  align?: 'left' | 'right'
}

export interface ListRowProps {
  columns: readonly Column[]
  selected?: boolean
  width?: number
  /** Hide the marker column and keep every tone (rows that are not selectable). */
  plain?: boolean
}

/**
 * A selectable row of aligned columns. Selected: an accent `▸` and bold text. Not selected: the
 * `text` columns go muted (status tones stay), so the selection reads without a painted bar.
 */
export function ListRow({ columns, selected = false, width, plain = false }: ListRowProps) {
  const dim = !plain && !selected
  return (
    <Box {...(width === undefined ? {} : { width })}>
      {!plain && (
        <Box width={2} flexShrink={0}>
          <Txt tone="accent" bold>
            {selected ? `${G.pointer} ` : '  '}
          </Txt>
        </Box>
      )}
      {columns.map((c, i) => (
        <Box
          key={i}
          {...(c.width === undefined
            ? { flexGrow: 1, flexShrink: 1 }
            : { width: c.width, flexShrink: 0 })}
          {...(c.align === 'right' ? { justifyContent: 'flex-end' as const } : {})}
          marginRight={i < columns.length - 1 ? 1 : 0}
        >
          {typeof c.text === 'string' ? (
            <Txt
              tone={dim && (c.tone ?? 'text') === 'text' ? 'muted' : (c.tone ?? 'text')}
              wrap="truncate-end"
              {...(selected ? { bold: true } : {})}
            >
              {stripControl(c.text)}
            </Txt>
          ) : (
            c.text
          )}
        </Box>
      ))}
    </Box>
  )
}
