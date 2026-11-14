import { Box, useWindowSize } from 'ink'
import { G } from './glyphs.ts'
import { Reveal } from './reveal.tsx'
import { GUTTER } from './spacing.ts'
import { type Tone, Txt } from './text.tsx'
import { cells } from './text-width.ts'
import { useTheme } from './theme-context.tsx'
import { type ToastItem, type ToastLevel, useToastItems } from './use-toasts.tsx'
import { alertLinesOf, wrapLines } from './wrap-lines.ts'

const TONE: Record<ToastLevel, Tone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
}
const GLYPH: Record<ToastLevel, string> = {
  info: G.sep,
  success: G.done,
  warning: G.warn,
  error: G.failed,
}

/** The widest a toast box gets, and the room kept free of the terminal's side. */
export const TOAST_MAX_WIDTH = 40
const SIDE = 6
/** The first row of the stack: row 0 is the margin and row 1 holds the title and the connection mark, so toasts start below them. */
export const TOAST_TOP = 2

/** A toast's text rows: the glyph's column first, the continuation rows indented under the text. */
function ToastBox({ toast, max, lines }: { toast: ToastItem; max: number; lines: number }) {
  const theme = useTheme()
  const rows = wrapLines(toast.text, max - 4, lines)
  const shown = rows.length === 0 ? [''] : rows
  const inner = Math.max(...shown.map((r) => cells(r)))
  return (
    <Reveal visible={!toast.leaving} from={0} durationMs={150}>
      <Box flexDirection="column" width={inner + 4} paddingX={1} {...theme.bg('user-message')}>
        {shown.map((row, i) => (
          <Box key={i} width={inner + 2}>
            <Box flexShrink={0} width={2}>
              <Txt bold tone={TONE[toast.level]}>
                {i === 0 ? GLYPH[toast.level] : ' '}
              </Txt>
            </Box>
            <Txt>{row}</Txt>
          </Box>
        ))}
      </Box>
    </Reveal>
  )
}

/**
 * The toasts of the nearest `ToastProvider`, stacked at the top-right corner, from row `TOAST_TOP` (below the title row with the connection mark), over whatever is drawn
 * (absolute: it never moves the layout; it has no input, so it never takes a key). One compact filled
 * box per toast, the level's glyph first, the text wrapped on words to `min(40, columns - 6)` cells and
 * at most four rows (two under twenty terminal rows). Draws nothing while there is no toast.
 */
export function ToastStack({ columns, rows }: { columns?: number; rows?: number }) {
  const size = useWindowSize()
  const items = useToastItems()
  if (items.length === 0) return null
  const width = columns ?? size.columns
  const lines = alertLinesOf(rows ?? size.rows)
  const max = Math.max(8, Math.min(TOAST_MAX_WIDTH, width - SIDE))
  return (
    <Box
      position="absolute"
      top={TOAST_TOP}
      left={0}
      width={width}
      flexDirection="column"
      alignItems="flex-end"
      paddingRight={GUTTER}
    >
      {items.map((toast) => (
        <ToastBox key={toast.id} toast={toast} max={max} lines={lines} />
      ))}
    </Box>
  )
}
