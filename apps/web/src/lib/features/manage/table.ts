import type { Row } from '@keith/app-model/manage'

// Search, facets and sort of a section's rows (web). Pure: the table component keeps the state, these decide what it shows.

export type SortDir = 'asc' | 'desc'
export interface Sort {
  col: number
  dir: SortDir
}

/** The most distinct values a column may have and still offer a filter (a username column does not). */
export const FACET_MAX = 30

/** The columns that make a filter: two or more distinct values, at most `FACET_MAX`, and not the first column (it names the row). */
export function facetsOf(
  header: readonly string[],
  rows: readonly Row[],
): { col: number; label: string; values: string[] }[] {
  const out: { col: number; label: string; values: string[] }[] = []
  for (let col = 1; col < header.length; col++) {
    const values = [...new Set(rows.map((r) => r.cells[col] ?? '').filter((v) => v !== ''))].sort()
    if (values.length >= 2 && values.length <= FACET_MAX && rows.length > values.length)
      out.push({ col, label: header[col] ?? '', values })
  }
  return out
}

/** The rows that hold every word of `query` (cells and detail, case aside) and match each chosen facet value. */
export function filterRows(
  rows: readonly Row[],
  query: string,
  facets: Readonly<Record<number, string>> = {},
): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((r) => {
    for (const [col, value] of Object.entries(facets))
      if (value !== '' && (r.cells[Number(col)] ?? '') !== value) return false
    if (words.length === 0) return true
    const hay = `${r.cells.join(' ')} ${r.detail ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

const NUMBER = /^[^\d-]*(-?\d[\d,]*(?:\.\d+)?)/

/** A cell as a number when it starts like one (`$3.20`, `12`, `1,200 left`), else `undefined`. */
const numberOf = (cell: string): number | undefined => {
  const m = NUMBER.exec(cell.trim())
  if (m === null || m[1] === undefined) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** The rows ordered by one column: numerically when both cells read as numbers, else as text; the original order breaks ties. */
export function sortRows(rows: readonly Row[], sort: Sort | undefined): Row[] {
  if (sort === undefined) return [...rows]
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => {
      const x = a.row.cells[sort.col] ?? ''
      const y = b.row.cells[sort.col] ?? ''
      const nx = numberOf(x)
      const ny = numberOf(y)
      const c =
        nx !== undefined && ny !== undefined
          ? nx - ny
          : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
      return c * sign || a.at - b.at
    })
    .map((s) => s.row)
}

/** The sort after a click on a header: a new column starts ascending, the same one flips, a third click clears it. */
export function nextSort(current: Sort | undefined, col: number): Sort | undefined {
  if (current === undefined || current.col !== col) return { col, dir: 'asc' }
  return current.dir === 'asc' ? { col, dir: 'desc' } : undefined
}
