import { describe, expect, test } from 'bun:test'
import {
  isGroup,
  type MenuEntry,
  type MenuItem,
  menuTree,
  moveMenu,
  opensDirectly,
} from './menu-tree.ts'

/** Every leaf of the tree, groups flattened (a flat list for the summary tests). */
const leaves = (tree: readonly MenuEntry[]): MenuItem[] =>
  tree.flatMap((e) => (isGroup(e) ? [...e.children] : [e]))
const menuItems = (...a: Parameters<typeof menuTree>): MenuItem[] => leaves(menuTree(...a))
const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'nodes', title: 'Nodes' },
]
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
