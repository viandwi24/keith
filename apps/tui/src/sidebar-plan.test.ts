import { describe, expect, test } from 'bun:test'
import { BRAIN_ROWS, orbMaxRows, orbRowsFor, planSidebar } from './sidebar.tsx'
import { SIDEBAR_GRAPH_ROWS, SIDEBAR_ORB_MIN_ROWS } from './sidebar-head.tsx'

const all = { brain: true, tasks: true }

test('Brain is fixed at 9 rows, Nodes takes up to 6, Tasks the rest; frames sit on each other with no gap', () => {
  const plan = planSidebar(28, { ...all, nodeRows: 2 })
  expect(plan.brain).toBe(BRAIN_ROWS)
  expect(plan.nodes).toBe(4) // two borders and two nodes
  expect(plan.tasks).toBe(28 - 9 - 4)
  expect(planSidebar(60, { ...all, nodeRows: 20 }).nodes).toBe(6)
})

test('an empty Nodes panel still takes its borders and one line', () => {
  expect(planSidebar(28, { ...all, nodeRows: 0 }).nodes).toBe(3)
})

test('Tasks gets at least 4 rows (two borders and two lines): when it would get less, Nodes gives its place up', () => {
  const plan = planSidebar(13, { ...all, nodeRows: 3 })
  expect(plan.nodes).toBe(0)
  expect(plan.tasks).toBe(4)
  expect(plan.brain).toBe(9)
})

test('a hidden panel takes no rows', () => {
  expect(planSidebar(30, { brain: false, tasks: true, nodeRows: 1 })).toMatchObject({ brain: 0 })
  expect(planSidebar(30, { brain: true, tasks: false, nodeRows: 1 })).toMatchObject({ tasks: 0 })
})

describe('the wide mode: orb, wave graph, Brain, Tasks, Nodes', () => {
  const MAX_32 = orbMaxRows(32, 0.46)
  const MAX_40 = orbMaxRows(40, 0.46)

  test('the orb is as wide as the column when round: 14 rows at 32 columns, 18 at 40 (cell aspect 0.46)', () => {
    expect(MAX_32).toBe(14)
    expect(MAX_40).toBe(18)
    expect(orbMaxRows(32, 0.5)).toBe(16)
    expect(orbMaxRows(10, 0.46)).toBe(SIDEBAR_ORB_MIN_ROWS)
  })

  test('a column of 32 rows (40-row terminal) holds all five, to the last row; the orb is 8 rows', () => {
    const plan = planSidebar(32, { ...all, nodeRows: 2, orb: MAX_32 })
    expect(plan).toEqual({ orb: 8, graph: SIDEBAR_GRAPH_ROWS, brain: 9, tasks: 4, nodes: 4 })
    expect(plan.orb + plan.graph + plan.brain + plan.tasks + plan.nodes).toBe(32)
  })

  test('the orb takes the largest size that fits: per column height and width', () => {
    // [terminal rows, sidebar width, orb rows]: the column is rows - 8
    const table = [
      [36, 32, 0], // the orb stays in the header (the layout does not even ask)
      [38, 32, 0], // 6 rows under the fixed panels: under the orb minimum
      [40, 32, 8],
      [44, 32, 12],
      [45, 32, 13],
      [60, 32, 14],
      [37, 40, 0],
      [38, 40, 0],
      [45, 40, 13],
      [50, 40, 18],
      [60, 40, 18],
    ] as const
    for (const [rows, width, orb] of table) {
      const max = orbMaxRows(width, 0.46)
      expect(orbRowsFor(rows - 8, { max, brain: true, tasks: true })).toBe(orb)
      const plan = planSidebar(rows - 8, { ...all, nodeRows: 2, orb: max })
      expect(plan.orb).toBe(orb)
      expect(plan.tasks).toBeGreaterThanOrEqual(4)
    }
  })

  test('Nodes gives its place up before Tasks drops under 4 rows', () => {
    const plan = planSidebar(32, { ...all, nodeRows: 9, orb: MAX_32 })
    expect(plan.nodes).toBe(0)
    expect(plan.tasks).toBe(32 - plan.orb - SIDEBAR_GRAPH_ROWS - 9)
  })

  test('the orb never resizes when nodes come and go', () => {
    const sizes = new Set<number>()
    for (let nodeRows = 0; nodeRows < 12; nodeRows++)
      sizes.add(planSidebar(32, { ...all, nodeRows, orb: MAX_32 }).orb)
    expect(sizes.size).toBe(1)
  })

  test('never partial: with under 32 rows the orb is not drawn and the plan is the narrow one', () => {
    const fits = SIDEBAR_ORB_MIN_ROWS + SIDEBAR_GRAPH_ROWS + BRAIN_ROWS + 4 + 4
    expect(fits).toBe(32)
    expect(planSidebar(fits, { ...all, nodeRows: 1, orb: MAX_32 }).orb).toBe(8)
    const short = planSidebar(fits - 1, { ...all, nodeRows: 1, orb: MAX_32 })
    expect(short.orb).toBe(0)
    expect(short.graph).toBe(0)
    expect(short).toEqual(planSidebar(fits - 1, { ...all, nodeRows: 1 }))
  })

  test('without the Brain setting the orb stays, larger, and the graph goes with the Brain panel', () => {
    const plan = planSidebar(32, { brain: false, tasks: true, nodeRows: 1, orb: MAX_32 })
    expect(plan).toMatchObject({ orb: 14, graph: 0, brain: 0 })
  })
})
