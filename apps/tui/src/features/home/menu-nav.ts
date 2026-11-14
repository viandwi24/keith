import {
  isGroup,
  type MenuEntry,
  type MenuGroup,
  type MenuTarget,
  moveMenu,
  opensDirectly,
} from './menu-state.ts'

/** Where the open menu is: the top list, or the submenu of one group, with each level's selection. */
export interface MenuNav {
  /** Index of the open group in the top list (`undefined`: the top level). */
  group: number | undefined
  top: number
  sub: number
  /** The read-only detail box beside a section leaf is open. */
  detail: boolean
}

export const MENU_START: MenuNav = { group: undefined, top: 0, sub: 0, detail: false }

/** What a key did besides moving: close the menu, open a target, or say the core is needed. */
export type MenuAction =
  | { kind: 'close' }
  | { kind: 'open'; target: MenuTarget }
  | { kind: 'blocked' }
  | undefined

/** The keys the menu reads (an Ink `Key` has them). */
export interface MenuKey {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  return: boolean
  escape: boolean
}

/** The list the current level shows, its title (a group's) and the selected index. */
export function levelOf(tree: readonly MenuEntry[], nav: MenuNav) {
  const open = nav.group === undefined ? undefined : (tree[nav.group] as MenuGroup | undefined)
  const entries: readonly MenuEntry[] = open === undefined ? tree : open.children
  const raw = open === undefined ? nav.top : nav.sub
  const selected = Math.max(0, Math.min(raw, entries.length - 1))
  const entry = entries[selected]
  return {
    entries,
    title: open?.title,
    selected,
    entry,
    /** The selected row when it is a leaf (a group is no target). */
    item: entry === undefined || isGroup(entry) ? undefined : entry,
  }
}

/** One key in the open menu: the next state and what the screen must do. */
export function menuKey(
  tree: readonly MenuEntry[],
  nav: MenuNav,
  input: string,
  k: MenuKey,
  offline: boolean,
): { nav: MenuNav; action: MenuAction } {
  const { entries, selected, entry } = levelOf(tree, nav)
  const at = (i: number): MenuNav =>
    nav.group === undefined ? { ...nav, top: i } : { ...nav, sub: i }
  if (input === ' ') return { nav, action: { kind: 'close' } }
  if (k.escape || k.leftArrow) {
    if (nav.group !== undefined)
      return { nav: { ...nav, top: nav.group, group: undefined, detail: false }, action: undefined }
    return { nav, action: k.escape ? { kind: 'close' } : undefined }
  }
  if (k.upArrow || input === 'k')
    return { nav: at(moveMenu(selected, -1, entries.length)), action: undefined }
  if (k.downArrow || input === 'j')
    return { nav: at(moveMenu(selected, 1, entries.length)), action: undefined }
  if (entry === undefined || !(k.rightArrow || k.return)) return { nav, action: undefined }
  if (isGroup(entry))
    return {
      nav: { ...nav, top: selected, group: selected, sub: 0, detail: false },
      action: undefined,
    }
  // offline only Logout works: the rest is dimmed and says why
  if (offline && entry.id !== 'logout') return { nav, action: { kind: 'blocked' } }
  if (k.rightArrow || opensDirectly(entry))
    return { nav, action: { kind: 'open', target: entry.target } }
  return { nav: { ...nav, detail: !nav.detail }, action: undefined }
}
