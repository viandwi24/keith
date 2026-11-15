import { describe, expect, test } from 'bun:test'
import type { Row } from '@keith/app-model/manage'
import { facetsOf, filterRows, nextSort, sortRows } from './table.ts'

const row = (id: string, cells: string[], detail?: string): Row => ({
  id,
  cells,
  ...(detail === undefined ? {} : { detail }),
  actions: [],
})

const rows = [
  row('a', ['ana', 'member', '$10.00'], 'id a'),
  row('b', ['bo', 'member', '$2.50']),
  row('c', ['cy', 'owner', '$30.00'], 'id c'),
]

describe('facetsOf', () => {
  test('a column with a few repeated values filters; the first column never does', () => {
    const f = facetsOf(['USER', 'ROLE', 'SPENT'], rows)
    expect(f.map((x) => x.label)).toEqual(['ROLE'])
    expect(f[0]?.values).toEqual(['member', 'owner'])
  })

  test('one value or all-different values offer nothing', () => {
    expect(facetsOf(['U', 'R'], [row('a', ['x', 'same']), row('b', ['y', 'same'])])).toEqual([])
  })
})

describe('filterRows', () => {
  test('words match cells and detail, every word must', () => {
    expect(filterRows(rows, 'member').map((r) => r.id)).toEqual(['a', 'b'])
    expect(filterRows(rows, 'id c').map((r) => r.id)).toEqual(['c'])
    expect(filterRows(rows, 'member ana').map((r) => r.id)).toEqual(['a'])
  })

  test('a facet needs the exact cell', () => {
    expect(filterRows(rows, '', { 1: 'owner' }).map((r) => r.id)).toEqual(['c'])
    expect(filterRows(rows, '', { 1: '' }).length).toBe(3)
  })
})

describe('sortRows', () => {
  test('numbers sort as numbers, not text', () => {
    expect(sortRows(rows, { col: 2, dir: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortRows(rows, { col: 2, dir: 'desc' }).map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  test('text sorts by locale, ties keep their order', () => {
    expect(sortRows(rows, { col: 1, dir: 'asc' }).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  test('no sort keeps the order', () => {
    expect(sortRows(rows, undefined).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

test('nextSort cycles asc, desc, off', () => {
  const a = nextSort(undefined, 1)
  expect(a).toEqual({ col: 1, dir: 'asc' })
  const b = nextSort(a, 1)
  expect(b).toEqual({ col: 1, dir: 'desc' })
  expect(nextSort(b, 1)).toBeUndefined()
  expect(nextSort(b, 2)).toEqual({ col: 2, dir: 'asc' })
})
