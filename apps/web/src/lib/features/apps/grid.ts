// The size of a plugin view's grid (docs/specs/plugin-views.md, "Web"): how many cells of a monospace font fit the container.
// Pure: the component measures pixels and asks here.

/** The protocol's limits (`VIEW_LIMITS`): a smaller container shows the view cut, a larger one gets at most this. */
export const GRID_LIMITS = { cols: { min: 20, max: 400 }, rows: { min: 4, max: 200 } } as const

export interface CellSize {
  width: number
  height: number
}

export interface GridSize {
  cols: number
  rows: number
}

/** The text the component measures in a hidden probe: its width over this many characters is `PROBE_CHARS` cells. */
export const PROBE = 'MMMMMMMMMMMMMMMMMMMM'

/** One cell from the probe's box: the probe holds `PROBE_CHARS` characters on one line. `undefined` while the probe has no size. */
export function cellOf(
  probe: { width: number; height: number },
  chars = PROBE.length,
): CellSize | undefined {
  if (!(probe.width > 0) || !(probe.height > 0) || chars < 1) return undefined
  return { width: probe.width / chars, height: probe.height }
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

/** The cells that fit a box (whole cells, within the protocol's limits). `undefined` while the box or the cell has no size. */
export function gridOf(
  box: { width: number; height: number },
  cell: CellSize | undefined,
): GridSize | undefined {
  if (cell === undefined || !(box.width > 0) || !(box.height > 0)) return undefined
  return {
    cols: clamp(Math.floor(box.width / cell.width), GRID_LIMITS.cols.min, GRID_LIMITS.cols.max),
    rows: clamp(Math.floor(box.height / cell.height), GRID_LIMITS.rows.min, GRID_LIMITS.rows.max),
  }
}

export const sameGrid = (a: GridSize | undefined, b: GridSize | undefined): boolean =>
  a?.cols === b?.cols && a?.rows === b?.rows
