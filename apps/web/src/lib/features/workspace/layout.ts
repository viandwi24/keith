// Layout presets as pure functions: a desktop and the size of its area in, a pixel rect per window out. Keith arranges by meaning
// ("next to the chat", "focus on this"), so presets with stable slots come first; `free` uses each window's own rect (ADR-0037 §8).

import { cascadeRect, type Desktop, focusedOf, type LayoutPreset } from './model.ts'

/** Below this width a desktop shows one window at a time, whatever its preset (the phone cards come in P40.4). */
export const NARROW_WIDTH = 600
export const GAP = 12

export interface Area {
  width: number
  height: number
}

export interface PlacedWindow {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Minimised, or covered by a maximised or focused window: not drawn. */
  hidden: boolean
}

/** The preset a desktop is drawn with at this width. */
export const effectiveLayout = (layout: LayoutPreset, area: Area): LayoutPreset =>
  area.width < NARROW_WIDTH ? 'focus' : layout

interface Cell {
  x: number
  y: number
  w: number
  h: number
}

const full = (a: Area): Cell => ({ x: 0, y: 0, w: a.width, h: a.height })

/** `n` cells of equal height in a column, `gap` between them. */
function column(c: Cell, n: number, gap: number): Cell[] {
  const h = (c.h - gap * (n - 1)) / n
  return Array.from({ length: n }, (_, i) => ({ x: c.x, y: c.y + i * (h + gap), w: c.w, h }))
}

function split(a: Area, n: number, gap: number): Cell[] {
  if (n === 1) return [full(a)]
  const w = (a.width - gap) / 2
  return [
    { x: 0, y: 0, w, h: a.height },
    ...column({ x: w + gap, y: 0, w, h: a.height }, n - 1, gap),
  ]
}

function grid(a: Area, n: number, gap: number): Cell[] {
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const h = (a.height - gap * (rows - 1)) / rows
  const out: Cell[] = []
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols) // the last row's cells widen to fill it
    const w = (a.width - gap * (inRow - 1)) / inRow
    for (let c = 0; c < inRow; c++) out.push({ x: c * (w + gap), y: r * (h + gap), w, h })
  }
  return out
}

const round = (c: Cell): Cell => ({
  x: Math.round(c.x),
  y: Math.round(c.y),
  w: Math.round(c.w),
  h: Math.round(c.h),
})

/** Every window of the desktop with where it is drawn, in the desktop's order. */
export function placeWindows(desktop: Desktop, area: Area, gap = GAP): PlacedWindow[] {
  const visible = desktop.windows.filter((w) => w.state !== 'min')
  const maxed = visible.filter((w) => w.state === 'max').sort((a, b) => b.z - a.z)[0]
  const layout = effectiveLayout(desktop.layout, area)
  const cells = new Map<string, Cell>()

  if (maxed !== undefined) cells.set(maxed.id, full(area))
  else if (layout === 'focus') {
    const top = focusedOf(desktop)
    if (top !== undefined) cells.set(top.id, full(area))
  } else if (layout === 'free') {
    visible.forEach((w, i) => {
      const r = w.rect ?? cascadeRect(i)
      cells.set(w.id, {
        x: r.x * area.width,
        y: r.y * area.height,
        w: r.w * area.width,
        h: r.h * area.height,
      })
    })
  } else if (visible.length > 0) {
    const slots =
      layout === 'split'
        ? split(area, visible.length, gap)
        : layout === 'stack'
          ? column(full(area), visible.length, gap)
          : grid(area, visible.length, gap)
    for (const [i, w] of visible.entries()) cells.set(w.id, slots[i] as Cell)
  }

  return desktop.windows.map((w) => {
    const c = cells.get(w.id)
    return c === undefined
      ? { id: w.id, x: 0, y: 0, w: 0, h: 0, hidden: true }
      : { id: w.id, ...round(c), hidden: false }
  })
}

/** Whether two drawn windows overlap (touching edges do not). */
export const overlaps = (a: PlacedWindow, b: PlacedWindow): boolean =>
  !a.hidden && !b.hidden && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
