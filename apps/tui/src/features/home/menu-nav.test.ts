import { describe, expect, test } from 'bun:test'
import { levelOf, MENU_START, type MenuKey, menuKey } from './menu-nav.ts'
import { menuTree } from './menu-state.ts'

const NONE: MenuKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
}
const tree = menuTree(
  [
    { id: 'overview', title: 'Overview' },
    { id: 'people', title: 'People' },
    { id: 'plugins', title: 'Plugins' },
    { id: 'reviews', title: 'Reviews' },
  ],
  undefined,
  [{ viewId: 'notes.list', label: 'Notes' }],
  { logout: true },
)
const press = (nav: typeof MENU_START, key: Partial<MenuKey>, input = '', offline = false) =>
  menuKey(tree, nav, input, { ...NONE, ...key }, offline)

describe('menuKey', () => {
  test('down wraps through the top list; Logout directly follows Help', () => {
    let nav = MENU_START
    for (let i = 0; i < tree.length - 1; i++) nav = press(nav, { downArrow: true }).nav
    expect(levelOf(tree, nav).entry?.id).toBe('logout')
    expect(tree.at(-2)?.id).toBe('help')
    nav = press(nav, {}, 'j').nav
    expect(levelOf(tree, nav).entry?.id).toBe('overview')
  })

  test('right and enter open a group, left and esc go back onto the group', () => {
    const atPeople = press(MENU_START, {}, 'j').nav
    for (const key of [{ rightArrow: true }, { return: true }]) {
      const open = press(atPeople, key)
      expect(open.action).toBeUndefined()
      const lv = levelOf(tree, open.nav)
      expect(lv.title).toBe('People & access')
      expect(lv.entries.map((e) => e.title)).toEqual(['People'])
      for (const back of [{ leftArrow: true }, { escape: true }]) {
        const up = press(open.nav, back)
        expect(up.action).toBeUndefined()
        expect(levelOf(tree, up.nav).entry?.title).toBe('People & access')
      }
    }
  })

  test('esc closes only at the top level; space closes from any level', () => {
    expect(press(MENU_START, { escape: true }).action).toEqual({ kind: 'close' })
    expect(press(MENU_START, { leftArrow: true }).action).toBeUndefined()
    const sub = press(press(MENU_START, {}, 'j').nav, { rightArrow: true }).nav
    expect(press(sub, {}, ' ').action).toEqual({ kind: 'close' })
  })

  test('a leaf opens its target; offline only Logout does, a group still opens', () => {
    const apps = press(press(MENU_START, {}, 'j').nav, {}, 'j').nav
    const inApps = press(apps, { return: true }).nav
    expect(levelOf(tree, inApps).entries.map((e) => e.title)).toEqual([
      'Notes',
      'Plugins',
      'Reviews',
    ])
    expect(press(inApps, { rightArrow: true }).action).toEqual({
      kind: 'open',
      target: { kind: 'view', viewId: 'notes.list', label: 'Notes' },
    })
    expect(press(inApps, { rightArrow: true }, '', true).action).toEqual({ kind: 'blocked' })
    expect(press(apps, { rightArrow: true }, '', true).nav.group).toBeDefined()
    const logout = { ...MENU_START, top: tree.length - 1 }
    expect(press(logout, { return: true }, '', true).action).toEqual({
      kind: 'open',
      target: { kind: 'logout' },
    })
  })

  test('enter on a section leaf toggles the detail box', () => {
    const t = press(MENU_START, { return: true })
    expect(t.nav.detail).toBe(true)
    expect(press(t.nav, { return: true }).nav.detail).toBe(false)
  })
})
