import { describe, expect, test } from 'bun:test'
import {
  clampIndex,
  filterItems,
  groupsOf,
  isPaletteShortcut,
  MANAGE_SECTIONS,
  moveIndex,
  opensPalette,
  paletteItems,
  paletteKeyAction,
} from './model.ts'

const NAV = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'chat', label: 'Chat', path: '/chat' },
  { id: 'inbox', label: 'Inbox', path: '/inbox' },
  { id: 'tasks', label: 'Tasks', path: '/tasks' },
]
const input = {
  nav: NAV,
  sections: MANAGE_SECTIONS,
  notificationsLabel: 'Turn on desktop notifications',
  stillOrb: false,
}

describe('paletteItems', () => {
  const items = paletteItems(input)
  test('navigation targets, actions and the TUI menu groups', () => {
    const groups = groupsOf(items).map((g) => g.group)
    expect(groups).toEqual([
      'Go to',
      'Actions',
      'Menu',
      'People & access',
      'Apps',
      'Models & budget',
      'System',
      'Menu',
    ])
    expect(items.filter((i) => i.group === 'Go to').map((i) => i.label)).toEqual([
      'Home',
      'Chat',
      'Inbox',
      'Tasks',
    ])
    expect(items.find((i) => i.id === 'nav:chat')?.action).toEqual({ kind: 'goto', path: '/chat' })
    for (const id of ['act:new', 'act:compact', 'act:theme', 'act:signout', 'act:stepup'])
      expect(items.some((i) => i.id === id)).toBe(true)
    expect(items.find((i) => i.id === 'act:new')?.action).toEqual({ kind: 'new' })
  })
  test('a member has no admin groups: System (Tasks, Brain trace) and Help', () => {
    const member = paletteItems({ ...input, sections: [] })
    expect(groupsOf(member).map((g) => g.group)).toEqual(['Go to', 'Actions', 'System', 'Menu'])
    expect(member.find((i) => i.id === 'menu:trace')?.action).toEqual({
      kind: 'goto',
      path: '/brain',
    })
    expect(member.find((i) => i.id === 'menu:help')?.action).toEqual({
      kind: 'goto',
      path: '/help',
    })
  })
  test('the notification and orb items say what they will do', () => {
    expect(items.find((i) => i.id === 'act:notify')?.label).toBe('Turn on desktop notifications')
    expect(items.find((i) => i.id === 'act:still')?.label).toBe('Keep the orb still')
    expect(
      paletteItems({ ...input, stillOrb: true }).find((i) => i.id === 'act:still')?.label,
    ).toBe('Animate the orb')
  })
})

describe('filterItems', () => {
  const items = paletteItems(input)
  test('an empty query keeps the order', () => {
    expect(filterItems(items, '  ').map((i) => i.id)).toEqual(items.map((i) => i.id))
  })
  test('a label that starts with the word beats one that only contains it', () => {
    const found = filterItems(items, 'ta').map((i) => i.label)
    expect(found[0]).toBe('Tasks')
  })
  test('every word must match; keywords and groups count', () => {
    expect(filterItems(items, 'log out').map((i) => i.id)).toEqual(['act:signout'])
    expect(filterItems(items, 'chat zebra')).toEqual([])
    expect(filterItems(items, 'logout').map((i) => i.id)).toEqual(['act:signout'])
    expect(filterItems(items, 'people').some((i) => i.id === 'menu:people')).toBe(true)
    expect(filterItems(items, 'apps plugins').map((i) => i.id)).toEqual(['menu:plugins'])
    expect(filterItems(items, 'zzzz')).toEqual([])
  })
  test('is case blind', () => {
    expect(filterItems(items, 'SIGN').map((i) => i.id)).toContain('act:signout')
  })
})

describe('keys', () => {
  test('Ctrl+K and Cmd+K open the palette, alone', () => {
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true })).toBe(true)
    expect(isPaletteShortcut({ key: 'K', metaKey: true })).toBe(true)
    expect(isPaletteShortcut({ key: 'k' })).toBe(false)
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBe(false)
  })
  test('a plain key never opens it, in a text field or not', () => {
    expect(opensPalette({ key: '/' })).toBe(false)
    expect(opensPalette({ key: 'k' })).toBe(false)
    expect(opensPalette({ key: 'k', metaKey: true })).toBe(true)
  })
  test('inside: arrows and Ctrl+N/P move, Enter runs, Esc closes, composing keys do nothing', () => {
    expect(paletteKeyAction({ key: 'ArrowDown' })).toEqual({ type: 'move', delta: 1 })
    expect(paletteKeyAction({ key: 'ArrowUp' })).toEqual({ type: 'move', delta: -1 })
    expect(paletteKeyAction({ key: 'n', ctrlKey: true })).toEqual({ type: 'move', delta: 1 })
    expect(paletteKeyAction({ key: 'p', ctrlKey: true })).toEqual({ type: 'move', delta: -1 })
    expect(paletteKeyAction({ key: 'Enter' })).toEqual({ type: 'run' })
    expect(paletteKeyAction({ key: 'Escape' })).toEqual({ type: 'close' })
    expect(paletteKeyAction({ key: 'Enter', isComposing: true })).toBeUndefined()
    expect(paletteKeyAction({ key: 'a' })).toBeUndefined()
  })
  test('the selection wraps and stays inside a shrinking list', () => {
    expect(moveIndex(0, -1, 3)).toBe(2)
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(0, 1, 0)).toBe(0)
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(1, 0)).toBe(0)
  })
})
