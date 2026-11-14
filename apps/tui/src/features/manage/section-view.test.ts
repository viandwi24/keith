import { describe, expect, test } from 'bun:test'
import type { Row } from './manage-types.ts'
import { fitWidths } from './section-view.tsx'

const row = (cells: string[]): Row => ({ id: cells[0] ?? '', cells, actions: [] })

describe('fitWidths', () => {
  const rows = [row(['owner', 'Owner', 'owner', '◐ suspended'])]

  test('wide enough: the widths stay', () => {
    expect(fitWidths([16, 18, 8], rows, undefined, 100)).toEqual([16, 18, 8])
  })

  test('narrow: the widest columns give up cells so the last column keeps its word', () => {
    const fit = fitWidths([16, 18, 8], rows, ['A', 'B', 'C', 'STATUS'], 54)
    // marker 2 + three gaps + the 11-cell status leave 38 cells for the fixed columns
    expect(fit.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(38)
    expect(Math.min(...fit)).toBeGreaterThanOrEqual(6)
  })
})
