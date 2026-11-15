import { describe, expect, test } from 'bun:test'
import { cellOf, GRID_LIMITS, gridOf, PROBE, sameGrid } from './grid.ts'

describe('cell measure', () => {
  test('one cell is the probe width over its characters and its height', () => {
    expect(cellOf({ width: 160, height: 18 })).toEqual({ width: 160 / PROBE.length, height: 18 })
    expect(cellOf({ width: 100, height: 20 }, 10)).toEqual({ width: 10, height: 20 })
  })
  test('a probe without a size (hidden, not laid out) gives no cell', () => {
    expect(cellOf({ width: 0, height: 18 })).toBeUndefined()
    expect(cellOf({ width: 160, height: Number.NaN })).toBeUndefined()
  })
})

describe('grid size', () => {
  const cell = { width: 8, height: 16 }
  test('whole cells fit the box', () => {
    expect(gridOf({ width: 805, height: 335 }, cell)).toEqual({ cols: 100, rows: 20 })
  })
  test('the protocol limits clamp it', () => {
    expect(gridOf({ width: 80, height: 32 }, cell)).toEqual({
      cols: GRID_LIMITS.cols.min,
      rows: GRID_LIMITS.rows.min,
    })
    expect(gridOf({ width: 9000, height: 9000 }, cell)).toEqual({
      cols: GRID_LIMITS.cols.max,
      rows: GRID_LIMITS.rows.max,
    })
  })
  test('no box or no cell means unknown', () => {
    expect(gridOf({ width: 0, height: 100 }, cell)).toBeUndefined()
    expect(gridOf({ width: 100, height: 100 }, undefined)).toBeUndefined()
  })
  test('sameGrid compares cols and rows', () => {
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true)
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false)
  })
})
