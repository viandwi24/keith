import { expect, test } from 'bun:test'
import { effectiveLayout, overlaps, type PlacedWindow, placeWindows } from './layout.ts'
import {
  type Desktop,
  LAYOUTS,
  type LayoutPreset,
  MAX_WINDOWS,
  type WorkspaceWindow,
} from './model.ts'

const win = (i: number, extra: Partial<WorkspaceWindow> = {}): WorkspaceWindow => ({
  id: `w${i}`,
  app: 'web:chat',
  title: `W${i}`,
  state: 'normal',
  z: i,
  openedBy: 'person',
  ...extra,
})

const desktop = (layout: LayoutPreset, n: number): Desktop => ({
  id: 'd1',
  name: 'D',
  layout,
  windows: Array.from({ length: n }, (_, i) => win(i + 1)),
})

const AREAS = [
  { width: 375, height: 640 },
  { width: 960, height: 520 },
  { width: 1440, height: 780 },
]

const inside = (p: PlacedWindow, a: { width: number; height: number }): boolean =>
  p.hidden || (p.x >= 0 && p.y >= 0 && p.x + p.w <= a.width + 1 && p.y + p.h <= a.height + 1)

test('every preset lays out 1 to 12 windows inside the area and without overlap', () => {
  for (const area of AREAS)
    for (const layout of LAYOUTS.filter((l) => l !== 'free'))
      for (let n = 1; n <= MAX_WINDOWS; n++) {
        const placed = placeWindows(desktop(layout, n), area)
        expect(placed).toHaveLength(n)
        expect(placed.some((p) => !p.hidden)).toBe(true)
        for (const p of placed) expect(inside(p, area)).toBe(true)
        for (const a of placed)
          for (const b of placed) if (a !== b) expect(overlaps(a, b)).toBe(false)
      }
})

test('split puts the first window on the left half and stacks the rest on the right', () => {
  const [a, b, c] = placeWindows(desktop('split', 3), { width: 1012, height: 612 })
  expect(a).toMatchObject({ x: 0, y: 0, w: 500, h: 612 })
  expect(b).toMatchObject({ x: 512, y: 0, w: 500, h: 300 })
  expect(c).toMatchObject({ x: 512, y: 312, w: 500, h: 300 })
})

test('focus shows only the window on top; a narrow screen always focuses', () => {
  const placed = placeWindows(desktop('focus', 3), { width: 1200, height: 700 })
  expect(placed.filter((p) => !p.hidden).map((p) => p.id)).toEqual(['w3'])
  expect(effectiveLayout('grid', { width: 375, height: 700 })).toBe('focus')
  expect(effectiveLayout('grid', { width: 960, height: 700 })).toBe('grid')
})

test('a maximised window covers the desktop and minimised ones are not drawn', () => {
  const d: Desktop = {
    ...desktop('grid', 3),
    windows: [win(1, { state: 'max' }), win(2, { state: 'min' }), win(3)],
  }
  const placed = placeWindows(d, { width: 1000, height: 600 })
  expect(placed.map((p) => p.hidden)).toEqual([false, true, true])
  expect(placed[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 600 })
})

test('free uses each window rect as fractions of the area', () => {
  const d: Desktop = {
    ...desktop('free', 1),
    windows: [win(1, { rect: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } })],
  }
  expect(placeWindows(d, { width: 1000, height: 800 })[0]).toMatchObject({
    x: 250,
    y: 400,
    w: 500,
    h: 200,
  })
})
