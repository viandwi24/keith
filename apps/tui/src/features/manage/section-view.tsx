import { type Column, G, ListRow, Notice, PulseGlyph, type Tone, Txt } from '@keith/ui'
import { Box } from 'ink'
import type { Row, SectionData } from './manage-types.ts'

/** What a status glyph in a cell is drawn in; the word after it carries the meaning without colour. */
const GLYPH_TONE: Record<string, Tone> = {
  [G.dot]: 'success',
  [G.working]: 'info',
  [G.idle]: 'muted',
  [G.warn]: 'warning',
  [G.failed]: 'danger',
}
const STATUS = /^([●◐○!✕]) (.*)$/s

function Cell({ text, tone, selected }: { text: string; tone: Tone; selected: boolean }) {
  const dim = !selected && tone === 'text' ? 'muted' : tone
  const bold = selected ? { bold: true } : {}
  const status = STATUS.exec(text)
  if (status === null)
    return (
      <Txt tone={dim} wrap="truncate-end" {...bold}>
        {text}
      </Txt>
    )
  const [, glyph = '', rest = ''] = status
  return (
    <Box>
      <Txt tone={GLYPH_TONE[glyph] ?? 'muted'} bold>
        {glyph}
      </Txt>
      <Txt tone={dim} wrap="truncate-end" {...bold}>{` ${rest}`}</Txt>
    </Box>
  )
}

/**
 * The fixed column widths that leave the last column the room its longest cell needs: on a narrow
 * pane the widest columns give up cells first (never below 6), so a status word is not cut.
 */
export function fitWidths(
  widths: readonly number[],
  rows: readonly Row[],
  header: readonly string[] | undefined,
  width: number,
): number[] {
  const out = [...widths]
  const columns = out.length + 1
  const lastNeed = Math.min(
    16,
    Math.max(...rows.map((r) => r.cells.at(-1)?.length ?? 0), header?.at(-1)?.length ?? 0),
  )
  const budget = width - 2 - (columns - 1) - lastNeed
  while (out.reduce((a, b) => a + b, 0) > budget) {
    let widest = 0
    for (let i = 1; i < out.length; i++) if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i
    if ((out[widest] ?? 0) <= 6) break
    out[widest] = (out[widest] ?? 0) - 1
  }
  return out
}

/** The columns of a row; the last takes the rest of the width. */
export const rowColumns = (row: Row, widths: readonly number[], selected: boolean): Column[] =>
  row.cells.map((text, i) => {
    const width = widths[i]
    return {
      text: (
        <Cell text={text} tone={row.tone ?? (i === 0 ? 'text' : 'muted')} selected={selected} />
      ),
      ...(width === undefined || i === row.cells.length - 1 ? { flex: true } : { width }),
    }
  })

const FACT = /^([a-z][a-z ]*?) {2,}(.*)$/

/** One fact line of a section: `people    3`, the key dim and aligned, the value in the text colour. */
export function FactLine({ line }: { line: string }) {
  const fact = FACT.exec(line)
  if (fact === null)
    return (
      <Txt wrap="truncate-end" tone="muted">
        {line}
      </Txt>
    )
  const [, key = '', value = ''] = fact
  return (
    <Box>
      <Box width={10} flexShrink={0}>
        <Txt tone="muted">{key}</Txt>
      </Box>
      <Txt wrap="truncate-end">{value}</Txt>
    </Box>
  )
}

export interface SectionViewProps {
  data: SectionData
  rows: readonly Row[]
  /** The window of `rows` to draw and the selected index. */
  start: number
  end: number
  at: number
  /** The rows have the keys: the selection shows. */
  focus: boolean
  working: boolean
  said: { level: 'info' | 'warning' | 'error'; text: string } | undefined
  help: readonly string[] | undefined
  /** Columns of the pane's content. */
  width: number
}

/** The body of a section in its frame: fact lines, a dim header, rows, the selected row's detail, notices. */
export function SectionView({
  data,
  rows,
  start,
  end,
  at,
  focus,
  working,
  said,
  help,
  width,
}: SectionViewProps) {
  const widths = fitWidths(data.widths ?? [], rows, data.header, width)
  const row = rows[at]
  return (
    <Box flexDirection="column" width={width}>
      {(data.loading || working) && (
        <Box>
          <PulseGlyph />
          <Txt tone="muted">{working ? ' working' : ' loading'}</Txt>
        </Box>
      )}
      {data.lines.map((line, i) => (
        <FactLine key={i} line={line} />
      ))}
      {data.lines.length > 0 && rows.length > 0 && <Box height={1} flexShrink={0} />}
      {data.header !== undefined && rows.length > 0 && (
        <ListRow
          width={width}
          columns={rowColumns(
            { id: '', cells: data.header, tone: 'muted', actions: [] },
            widths,
            false,
          )}
        />
      )}
      {rows.slice(start, end).map((r, i) => (
        <ListRow
          key={r.id}
          selected={focus && start + i === at}
          width={width}
          columns={rowColumns(r, widths, focus && start + i === at)}
        />
      ))}
      {rows.length === 0 && !data.loading && data.empty !== undefined && data.empty !== '' && (
        <Txt tone="muted" wrap="truncate-end">
          {data.empty}
        </Txt>
      )}
      {row?.detail !== undefined && (
        <Box marginTop={1}>
          <Txt tone="muted" wrap="truncate-end">
            {row.detail}
          </Txt>
        </Box>
      )}
      {data.error !== undefined && (
        <Box marginTop={1}>
          <Notice level="error" rows={[`Failed to load: ${data.error}`]} />
        </Box>
      )}
      {said !== undefined && (
        <Box marginTop={1}>
          <Notice level={said.level} rows={[said.text]} />
        </Box>
      )}
      {help !== undefined && (
        <Box marginTop={1}>
          <Notice level="info" rows={help} />
        </Box>
      )}
    </Box>
  )
}
