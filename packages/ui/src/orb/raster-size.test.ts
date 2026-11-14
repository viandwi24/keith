import { describe, expect, test } from 'bun:test'
import { ORB_COLORS, PLAIN } from './fixtures.ts'
import { Orb } from './orb.ts'
import { rasterize } from './raster.ts'

// The chat sidebar draws the orb in a box as wide as its column and 6 to 18 rows high: at every
// size the orb must stay a circle at the terminal's cell shape.
describe('the orb at the sizes of the chat sidebar', () => {
  const sizes = [
    [32, 6],
    [32, 10],
    [32, 14],
    [40, 15],
    [40, 18],
  ] as const
  test.each(sizes)('%i columns x %i rows stays round at cell aspect 0.46', (cols, rows) => {
    const aspect = 0.46
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const lines = rasterize(orb.step(0.03), cols, rows, ORB_COLORS.idle, PLAIN, aspect)
    expect(lines).toHaveLength(rows)
    for (const l of lines) expect([...l]).toHaveLength(cols)
    const cells: Array<[number, number]> = []
    lines.forEach((l, y) => {
      ;[...l].forEach((ch, x) => {
        if (ch !== ' ') cells.push([x, y])
      })
    })
    expect(cells.length).toBeGreaterThan(rows * 3)
    const xs = cells.map(([x]) => x)
    const ys = cells.map(([, y]) => y)
    // physical size with a cell height of 1: a cell is `aspect` wide
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * aspect
    const h = Math.max(...ys) - Math.min(...ys) + 1
    expect(Math.abs(w - h) / h).toBeLessThan(0.2)
    // it uses the room: the diameter is the smaller of the box's two physical sides
    expect(h).toBeGreaterThanOrEqual(Math.min(cols * aspect, rows) * 0.8)
    // centred in the box
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (cols - 1) / 2)).toBeLessThan(2)
  })
})
