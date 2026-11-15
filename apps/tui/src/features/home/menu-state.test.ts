import { describe, expect, test } from 'bun:test'
import type { Task } from '@keith/contracts'
import {
  isGroup,
  type MenuEntry,
  type MenuItem,
  menuTree,
  type SummaryData,
  summaryOf,
} from './menu-state.ts'

/** Every leaf of the tree, groups flattened (a flat list for the summary tests). */
const leaves = (tree: readonly MenuEntry[]): MenuItem[] =>
  tree.flatMap((e) => (isGroup(e) ? [...e.children] : [e]))
const menuItems = (...a: Parameters<typeof menuTree>): MenuItem[] => leaves(menuTree(...a))
const _OWNER = [
  { id: 'overview', title: 'Overview' },
  { id: 'people', title: 'People' },
  { id: 'groups', title: 'Groups' },
  { id: 'plugins', title: 'Plugins' },
  { id: 'reviews', title: 'Reviews' },
  { id: 'protocols', title: 'Protocols' },
  { id: 'devices', title: 'Devices & tokens' },
  { id: 'nodes', title: 'Nodes' },
  { id: 'providers', title: 'Providers & models' },
  { id: 'access', title: 'Access' },
  { id: 'budget', title: 'Budget' },
  { id: 'audit', title: 'Audit' },
]

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'nodes', title: 'Nodes' },
]
const data: SummaryData = {
  me: undefined,
  connection: 'live',
  health: { status: 'ok', version: '0.1.0', sha: 'abc', boot: 'b' },
  roles: { front: 'openrouter/anthropic/claude-haiku-5.5', cortex: null },
  budget: undefined,
  nodes: [],
  tasks: [
    { id: 't1', agent: 'cortex.research', description: 'read news', status: 'running' } as Task,
  ],
  brain: { lastAt: {}, cortexActive: [], last: undefined, trace: [], dreaming: undefined },
}

describe('summaryOf', () => {
  test('a plugin view has no live lines', () => {
    const view = menuItems(sections, undefined, [{ viewId: 'notes.list', label: 'Notes' }]).find(
      (i) => i.id === 'notes.list',
    )
    expect(view === undefined ? ['x'] : summaryOf(view, data)).toEqual([])
  })

  const [overview, , tasks] = menuItems(sections)
  test('derives live lines from what the app holds', () => {
    expect(overview && summaryOf(overview, data)).toEqual([
      'connection online',
      'core 0.1.0 ok',
      'no identity',
      'front claude-haiku-5.5',
    ])
    expect(tasks && summaryOf(tasks, data)).toEqual([
      '1 running, 1 total',
      'cortex.research: read news',
    ])
  })

  test('never more than four lines; a section without live data has one static line', () => {
    for (const item of menuItems([
      ...sections,
      { id: 'people', title: 'People' },
      { id: 'audit', title: 'Audit' },
    ]))
      expect(summaryOf(item, data).length).toBeLessThanOrEqual(4)
    const people = menuItems([{ id: 'people', title: 'People' }])[0]
    expect(people && summaryOf(people, data)).toHaveLength(1)
  })
})

describe('what moved out of the header', () => {
  const overview = {
    id: 'overview',
    title: 'Overview',
    target: { kind: 'section', index: 0 },
  } as const
  const budgetItem = {
    id: 'budget',
    title: 'Budget',
    target: { kind: 'section', index: 1 },
  } as const
  const spend = (spentUsd: number) => ({
    periodStart: 0,
    periodEnd: 1,
    unpriced: [],
    limitUsd: 20,
    spentUsd,
    reservedUsd: 0,
    remainingUsd: 20 - spentUsd,
  })

  test('Overview carries the connection, the core version and the front model', () => {
    const lines = summaryOf(overview, data)
    expect(lines).toContain('connection online')
    expect(lines).toContain('core 0.1.0 ok')
    expect(lines).toContain('front claude-haiku-5.5')
    expect(summaryOf(overview, { ...data, connection: 'offline' })).toContain('connection offline')
  })

  test('Budget shows the spend, the limit, what is left', () => {
    const lines = summaryOf(budgetItem, { ...data, budget: spend(3.21) as never })
    expect(lines).toEqual(['$3.21 / $20 this month', '$16.79 left'])
  })

  test('over 80 % of the limit the Budget item gets a ! and its box says so; at 100 % it says reached', () => {
    const sec = [{ id: 'budget', title: 'Budget' }]
    expect(menuItems(sec, spend(3) as never)[0]?.flag).toBeUndefined()
    expect(menuItems(sec)[0]?.flag).toBeUndefined()
    expect(menuItems(sec, spend(17) as never)[0]?.flag).toBe('!')
    expect(summaryOf(budgetItem, { ...data, budget: spend(17) as never })).toContain(
      '! over 80% of the limit',
    )
    expect(summaryOf(budgetItem, { ...data, budget: spend(20) as never })).toContain(
      '! limit reached',
    )
  })

  test('Audit has no data in the app: a description and the way in', () => {
    const audit = { id: 'audit', title: 'Audit', target: { kind: 'section', index: 2 } } as const
    expect(summaryOf(audit, data)).toEqual(['The record of sensitive actions.', '→ open'])
  })
})
