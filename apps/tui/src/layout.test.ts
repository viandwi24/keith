import { describe, expect, test } from 'bun:test'
import { layoutOf } from './layout.ts'

test('under 60 columns the app is unsupported', () => {
  expect(layoutOf(59).supported).toBe(false)
  expect(layoutOf(60).supported).toBe(true)
})

test('60-99 columns: single column, the activity strip stands in for the sidebar', () => {
  for (const columns of [60, 99]) {
    const l = layoutOf(columns)
    expect(l.sidebar).toBe(0)
    expect(l.strip).toBe(true)
    expect(l.left).toBe(columns)
  }
})

test('ctrl+b shows a 32-column sidebar on a narrow screen, and hides the default one', () => {
  const shown = layoutOf(80, { sidebar: true })
  expect(shown.sidebar).toBe(32)
  expect(shown.strip).toBe(false)
  expect(shown.left).toBe(80 - 32 - 3 - 2)
  expect(layoutOf(120, { sidebar: false }).sidebar).toBe(0)
  expect(layoutOf(120, { sidebar: false }).strip).toBe(false)
})

test('100-159 columns: a 32-column sidebar, a blank column, the separator and a blank column, and the 2-column right margin of the title row', () => {
  for (const columns of [100, 159]) {
    const l = layoutOf(columns)
    expect(l.sidebar).toBe(32)
    expect(l.strip).toBe(false)
    expect(l.left).toBe(columns - 37)
  }
})

test('160 columns and more: a 40-column sidebar; the conversation fills the room up to it', () => {
  const l = layoutOf(160)
  expect(l.sidebar).toBe(40)
  expect(l.left).toBe(115)
  // no prose cap: the text column is the left column minus gutter and indent
  expect(l.prose).toBe(l.left - 4)
  expect(l.conversation).toBe(l.left)
  const wider = layoutOf(240)
  expect(wider.sidebar).toBe(40)
  expect(wider.prose).toBe(wider.left - 4)
  expect(layoutOf(100).prose).toBe(63 - 4)
})

test('height: under 20 rows the footer hides, under 12 the sidebar hides at any width', () => {
  expect(layoutOf(120, { rows: 20 }).footer).toBe(true)
  expect(layoutOf(120, { rows: 19 }).footer).toBe(false)
  expect(layoutOf(120, { rows: 19 }).sidebar).toBe(32)
  expect(layoutOf(120, { rows: 12 }).sidebar).toBe(32)
  const tiny = layoutOf(200, { rows: 11 })
  expect(tiny.sidebar).toBe(0)
  expect(tiny.footer).toBe(false)
  expect(layoutOf(80, { rows: 11, sidebar: true }).sidebar).toBe(0)
})

test('the chat header needs 80 columns and 20 rows', () => {
  expect(layoutOf(80, { rows: 20 }).header).toBe(true)
  expect(layoutOf(79, { rows: 20 }).header).toBe(false)
  expect(layoutOf(100, { rows: 19 }).header).toBe(false)
  expect(layoutOf(120, { rows: 40 }).header).toBe(true)
})

describe('the orb moves to the sidebar: columns x rows', () => {
  const columnsList = [59, 60, 99, 100, 159, 160]
  const rowsList = [11, 12, 19, 20, 35, 39, 40, 50]
  const cases = columnsList.flatMap((columns) => rowsList.map((rows) => [columns, rows] as const))
  test.each(cases)('%i columns x %i rows', (columns, rows) => {
    const l = layoutOf(columns, { rows })
    const sidebar = columns >= 100 && rows >= 12
    const orb = sidebar && columns >= 100 && rows >= 40
    expect(l.sidebar > 0).toBe(sidebar)
    expect(l.orbInSidebar).toBe(orb)
    expect(l.separator).toBe(sidebar ? 1 : 0)
    const header = columns >= 80 && rows >= 20
    expect(l.headerVariant).toBe(!header ? 'none' : orb ? 'title' : 'orb')
    expect(l.header).toBe(header)
  })

  test('ctrl+b: shown at 60-99 columns the sidebar has the separator but the orb stays in the header', () => {
    const l = layoutOf(90, { rows: 40, sidebar: true })
    expect(l.sidebar).toBe(32)
    expect(l.separator).toBe(1)
    expect(l.orbInSidebar).toBe(false)
    expect(l.headerVariant).toBe('orb')
  })

  test('ctrl+b: a hidden sidebar takes the orb back to the header and the separator away', () => {
    const l = layoutOf(160, { rows: 40, sidebar: false })
    expect(l.sidebar).toBe(0)
    expect(l.separator).toBe(0)
    expect(l.orbInSidebar).toBe(false)
    expect(l.headerVariant).toBe('orb')
  })

  test('the left column leaves a blank column, the separator and a blank column before the sidebar', () => {
    expect(layoutOf(120, { rows: 40 }).left).toBe(120 - 32 - 3 - 2)
    expect(layoutOf(200, { rows: 40 }).left).toBe(200 - 40 - 3 - 2)
  })
})
