import { describe, expect, test } from 'bun:test'
import type { Task } from '@keith/contracts'
import {
  isGroup,
  type MenuEntry,
  type MenuItem,
  menuTree,
  moveMenu,
  opensDirectly,
  type SummaryData,
  summaryOf,
} from './menu-state.ts'

/** Every leaf of the tree, groups flattened (a flat list for the summary tests). */
const leaves = (tree: readonly MenuEntry[]): MenuItem[] =>
  tree.flatMap((e) => (isGroup(e) ? [...e.children] : [e]))
const menuItems = (...a: Parameters<typeof menuTree>): MenuItem[] => leaves(menuTree(...a))
const OWNER = [
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

describe('menuTree', () => {
  test('Overview, four groups, Help and Logout; every leaf keeps its section index', () => {
    const tree = menuTree(OWNER, undefined, [], { logout: true })
    expect(tree.map((e) => e.title)).toEqual([
      'Overview',
      'People & access',
      'Apps',
      'Models & budget',
      'System',
      'Help',
      'Logout',
    ])
    const titles = (id: string) => {
      const g = tree.find((e) => e.id === id)
      return g !== undefined && isGroup(g) ? g.children.map((c) => c.title) : []
    }
    expect(titles('people-access')).toEqual(['People', 'Groups', 'Devices & tokens', 'Access'])
    expect(titles('models-budget')).toEqual(['Providers & models', 'Budget'])
    expect(titles('system')).toEqual(['Nodes', 'Audit', 'Tasks', 'Brain trace'])
    expect(menuItems(OWNER).find((i) => i.id === 'people')?.target).toEqual({
      kind: 'section',
      index: 1,
    })
    expect(tree.some((e) => e.title === 'Plugins')).toBe(false)
  })

  test('Apps lists the plugin views first, then Plugins, Reviews and Protocols; with no views it keeps the three', () => {
    const apps = (views: { viewId: string; label: string }[]) => {
      const g = menuTree(OWNER, undefined, views).find((e) => e.id === 'apps')
      return g !== undefined && isGroup(g) ? g.children : []
    }
    const full = apps([
      { viewId: 'notes.list', label: 'Notes' },
      { viewId: 'reminders.list', label: 'Reminders' },
    ])
    expect(full.map((c) => c.title)).toEqual([
      'Notes',
      'Reminders',
      'Plugins',
      'Reviews',
      'Protocols',
    ])
    expect(full[0]?.target).toEqual({ kind: 'view', viewId: 'notes.list', label: 'Notes' })
    expect(apps([]).map((c) => c.title)).toEqual(['Plugins', 'Reviews', 'Protocols'])
    const notes = full[0]
    expect(notes === undefined ? false : opensDirectly(notes)).toBe(true)
    expect(notes === undefined ? ['x'] : summaryOf(notes, data)).toEqual([])
  })

  test('Logout directly follows Help, is a leaf and opens directly', () => {
    const tree = menuTree(sections, undefined, [], { logout: true })
    expect(tree.at(-1)).toMatchObject({ id: 'logout', target: { kind: 'logout' } })
    expect(tree.at(-2)?.id).toBe('help')
    expect(menuTree([]).some((e) => e.id === 'logout')).toBe(false)
  })

  test('a member sees no admin groups: Help and System (Tasks, Brain trace) only', () => {
    const tree = menuTree([])
    expect(tree.map((e) => e.id)).toEqual(['system', 'help'])
    expect(leaves(tree).map((i) => i.id)).toEqual(['tasks', 'trace', 'help'])
  })

  test('a group is flagged when one of its leaves is', () => {
    const budget = { limitUsd: 20, spentUsd: 17, reservedUsd: 0, remainingUsd: 3 } as never
    const g = menuTree(OWNER, budget).find((e) => e.id === 'models-budget')
    expect(g?.flag).toBe('!')
    expect(menuTree(OWNER).find((e) => e.id === 'models-budget')?.flag).toBeUndefined()
  })
})

describe('moveMenu', () => {
  test('wraps around both ends', () => {
    expect(moveMenu(0, -1, 5)).toBe(4)
    expect(moveMenu(4, 1, 5)).toBe(0)
    expect(moveMenu(2, 1, 5)).toBe(3)
    expect(moveMenu(0, 1, 0)).toBe(0)
  })
})

describe('summaryOf', () => {
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
