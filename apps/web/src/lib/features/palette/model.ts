import { isGroup, type MenuEntry, type MenuItem, menuTree } from '@keith/app-model'
import { SECTION_META } from '@keith/app-model/manage'
import type { BudgetStatus } from '@keith/contracts'

/** What running a palette item does (the palette runs it; this file only describes it). */
export type PaletteAction =
  | { kind: 'goto'; path: string }
  | { kind: 'new' }
  | { kind: 'compact' }
  | { kind: 'theme' }
  | { kind: 'still-orb' }
  | { kind: 'notifications' }
  | { kind: 'sign-out' }
  | { kind: 'step-up' }

export interface PaletteItem {
  id: string
  label: string
  /** The section heading the item sits under. */
  group: string
  /** A short line shown at the right (a path, a key). */
  hint?: string
  /** Extra words the filter also reads. */
  keywords: readonly string[]
  action: PaletteAction
}

export interface NavTarget {
  id: string
  label: string
  /** Path under the app base; `/` is Home. */
  path: string
}

/** Every Manage section the TUI's menu has (ids and titles from `@keith/app-model/manage`); a person gets the ones their capabilities show. */
export const MANAGE_SECTIONS: readonly { id: string; title: string }[] = SECTION_META.map((s) => ({
  id: s.id,
  title: s.title,
}))

export interface PaletteInput {
  nav: readonly NavTarget[]
  /** The Manage sections this person has (none for a member). */
  sections: readonly { id: string; title: string }[]
  budget?: BudgetStatus | undefined
  /** The notification toggle's current words (`Turn on desktop notifications`). */
  notificationsLabel: string
  stillOrb: boolean
}

const goto = (path: string): PaletteAction => ({ kind: 'goto', path })

/** The TUI's menu entry as a palette item: a manage section opens Manage, Tasks, Brain trace and Help open their pages. */
function menuAction(item: MenuItem): PaletteAction | undefined {
  switch (item.target.kind) {
    case 'section':
      return goto(`/manage/${item.id}`)
    case 'tasks':
      return goto('/tasks')
    case 'trace':
      return goto('/brain')
    case 'help':
      return goto('/help')
    default:
      return undefined // plugin views and logout are other items here
  }
}

function menuItems(tree: readonly MenuEntry[]): PaletteItem[] {
  const out: PaletteItem[] = []
  const add = (item: MenuItem, group: string): void => {
    const action = menuAction(item)
    if (action === undefined) return
    out.push({
      id: `menu:${item.id}`,
      label: item.flag === undefined ? item.title : `${item.title} !`,
      group,
      keywords: [group],
      action,
    })
  }
  for (const entry of tree) {
    if (isGroup(entry)) for (const child of entry.children) add(child, entry.title)
    else add(entry, 'Menu')
  }
  return out
}

/** Every item of the palette, in the order it lists them: where to go, what to do, then the TUI's menu groups. */
export function paletteItems(input: PaletteInput): PaletteItem[] {
  const navigate: PaletteItem[] = input.nav.map((n) => ({
    id: `nav:${n.id}`,
    label: n.label,
    group: 'Go to',
    hint: n.path,
    keywords: [n.id],
    action: goto(n.path),
  }))
  const actions: PaletteItem[] = [
    {
      id: 'act:new',
      label: 'New conversation',
      group: 'Actions',
      hint: '/new',
      keywords: ['context', 'reset', 'fresh'],
      action: { kind: 'new' },
    },
    {
      id: 'act:compact',
      label: 'Compact the conversation',
      group: 'Actions',
      hint: '/compact',
      keywords: ['summarise', 'summarize', 'shrink'],
      action: { kind: 'compact' },
    },
    {
      id: 'act:theme',
      label: 'Switch theme',
      group: 'Actions',
      keywords: ['dark', 'light', 'appearance', 'system'],
      action: { kind: 'theme' },
    },
    {
      id: 'act:still',
      label: input.stillOrb ? 'Animate the orb' : 'Keep the orb still',
      group: 'Actions',
      keywords: ['motion', 'animation', 'reduce'],
      action: { kind: 'still-orb' },
    },
    {
      id: 'act:notify',
      label: input.notificationsLabel,
      group: 'Actions',
      keywords: ['notifications', 'alerts', 'desktop'],
      action: { kind: 'notifications' },
    },
    {
      id: 'act:stepup',
      label: 'Step up (confirm it is you)',
      group: 'Actions',
      keywords: ['elevate', 'pin', 'password', 'sudo'],
      action: { kind: 'step-up' },
    },
    {
      id: 'act:signout',
      label: 'Sign out',
      group: 'Actions',
      keywords: ['logout', 'leave'],
      action: { kind: 'sign-out' },
    },
  ]
  return [...navigate, ...actions, ...menuItems(menuTree(input.sections, input.budget))]
}

/** How well `item` matches one word: 0 best (label starts with it) to 3 (only a keyword or the group has it), -1 for no match. */
function rank(item: PaletteItem, word: string): number {
  const label = item.label.toLowerCase()
  if (label.startsWith(word)) return 0
  if (label.split(/[\s&/·-]+/).some((w) => w.startsWith(word))) return 1
  if (label.includes(word)) return 2
  const rest = `${item.group} ${item.keywords.join(' ')} ${item.hint ?? ''}`.toLowerCase()
  return rest.includes(word) ? 3 : -1
}

/** The items that match every word of `query`, best first (the list's own order breaks ties). No query keeps the order. */
export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  const scored: { item: PaletteItem; score: number; at: number }[] = []
  items.forEach((item, at) => {
    let score = 0
    for (const word of words) {
      const r = rank(item, word)
      if (r < 0) return
      score += r
    }
    scored.push({ item, score, at })
  })
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((s) => s.item)
}

/** The list keeps the items in groups: a heading before the first item of each group. */
export function groupsOf(items: readonly PaletteItem[]): { group: string; items: PaletteItem[] }[] {
  const out: { group: string; items: PaletteItem[] }[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (last?.group === item.group) last.items.push(item)
    else out.push({ group: item.group, items: [item] })
  }
  return out
}

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

/** ⌘K or Ctrl+K: opens (and closes) the palette, also while a text field has focus. */
export const isPaletteShortcut = (e: KeyLike): boolean =>
  (e.metaKey === true || e.ctrlKey === true) &&
  e.altKey !== true &&
  e.shiftKey !== true &&
  e.key.toLowerCase() === 'k'

/** Whether the page-level key opens the palette: only the shortcut does, whatever has focus. Nothing else is a page key. */
export const opensPalette = (e: KeyLike): boolean => isPaletteShortcut(e)

export type PaletteKeyAction = { type: 'move'; delta: -1 | 1 } | { type: 'run' } | { type: 'close' }

/** What a key does inside the open palette (the filter field has focus): arrows and Ctrl+N/P move, Enter runs, Esc closes. */
export function paletteKeyAction(e: KeyLike): PaletteKeyAction | undefined {
  if (e.isComposing === true) return undefined
  if (e.key === 'ArrowDown') return { type: 'move', delta: 1 }
  if (e.key === 'ArrowUp') return { type: 'move', delta: -1 }
  if (e.ctrlKey === true && e.metaKey !== true && e.altKey !== true) {
    if (e.key === 'n' || e.key === 'j') return { type: 'move', delta: 1 }
    if (e.key === 'p') return { type: 'move', delta: -1 }
  }
  if (e.key === 'Enter') return { type: 'run' }
  if (e.key === 'Escape') return { type: 'close' }
  return undefined
}

/** The selection one step on, wrapping at both ends; 0 for an empty list. */
export const moveIndex = (index: number, delta: -1 | 1, total: number): number =>
  total <= 0 ? 0 : (index + delta + total) % total

/** The selection kept inside the list after the list changed. */
export const clampIndex = (index: number, total: number): number =>
  total <= 0 ? 0 : Math.max(0, Math.min(index, total - 1))
