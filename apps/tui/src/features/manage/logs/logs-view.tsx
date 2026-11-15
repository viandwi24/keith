import {
  GENERATION_HEADER,
  GENERATION_WIDTHS,
  type LogLine,
  SESSION_HEADER,
  SESSION_WIDTHS,
} from '@keith/app-model/manage'
import { ListRow, Txt, windowOf } from '@keith/ui'
import { Box } from 'ink'
import type { Row } from '../manage-types.ts'
import { FactLine, fitWidths, rowColumns } from '../section-view.tsx'

/** The first line a scrolled body shows, kept inside its `total` lines and `rows` rows. */
export const clampOffset = (offset: number, total: number, rows: number): number =>
  Math.min(Math.max(0, offset), Math.max(0, total - rows))

interface TableProps {
  header: readonly string[]
  widths: readonly number[]
  rows: readonly Row[]
  /** The selected row; drawn only while the pane has the keys. */
  selected: number
  focus: boolean
  /** Data rows on screen (the header is one more row). */
  visible: number
  width: number
}

/** A dim header and the window of rows around the selected one, aligned in columns. */
function Table({ header, widths, rows, selected, focus, visible, width }: TableProps) {
  const fitted = fitWidths(widths, rows, header, width)
  const win = windowOf(selected, rows.length, visible)
  return (
    <Box flexDirection="column" width={width}>
      <ListRow
        width={width}
        columns={rowColumns({ id: '', cells: header, tone: 'muted', actions: [] }, fitted, false)}
      />
      {rows.slice(win.start, win.end).map((r, i) => {
        const at = win.start + i
        const on = focus && at === selected
        return (
          <ListRow key={r.id} selected={on} width={width} columns={rowColumns(r, fitted, on)} />
        )
      })}
    </Box>
  )
}

export interface SessionsListProps {
  rows: readonly Row[]
  selected: number
  focus: boolean
  /** Rows the pane can show, its header included. */
  height: number
  width: number
}

/** Level 1: the sessions, newest first. */
export function SessionsList({ rows, selected, focus, height, width }: SessionsListProps) {
  return (
    <Table
      header={SESSION_HEADER}
      widths={SESSION_WIDTHS}
      rows={rows}
      selected={selected}
      focus={focus}
      visible={Math.max(1, height - 1)}
      width={width}
    />
  )
}

export interface SessionBodyProps {
  facts: readonly LogLine[]
  rows: readonly Row[]
  selected: number
  focus: boolean
  height: number
  width: number
}

/** Level 2: the overview of one session above its generations (one row each). */
export function SessionBody({ facts, rows, selected, focus, height, width }: SessionBodyProps) {
  // the facts, one blank row, the table header: what is left is the generations
  const visible = Math.max(1, height - facts.length - 2)
  return (
    <Box flexDirection="column" width={width}>
      {facts.map((line) => (
        <FactLine key={line.text} line={line.text} />
      ))}
      <Box height={1} flexShrink={0} />
      <Table
        header={GENERATION_HEADER}
        widths={GENERATION_WIDTHS}
        rows={rows}
        selected={selected}
        focus={focus}
        visible={visible}
        width={width}
      />
    </Box>
  )
}

/** One line of a text body: a fact with its key dim, or the plain line in its tone (cut at the width, never wrapped). */
function LogLineRow({ line }: { line: LogLine }) {
  if (line.fact === true) return <FactLine line={line.text} />
  return (
    <Txt tone={line.tone ?? 'text'} bold={line.bold === true} wrap="truncate-end">
      {line.text}
    </Txt>
  )
}

export interface TextBodyProps {
  lines: readonly LogLine[]
  /** The first line on screen (clamped to the body). */
  offset: number
  height: number
  width: number
}

/** Levels 3 and 4: a read-only text body, scrolled by line. */
export function TextBody({ lines, offset, height, width }: TextBodyProps) {
  const start = clampOffset(offset, lines.length, height)
  return (
    <Box flexDirection="column" width={width}>
      {lines.slice(start, start + height).map((line, i) => (
        <LogLineRow key={start + i} line={line} />
      ))}
    </Box>
  )
}
