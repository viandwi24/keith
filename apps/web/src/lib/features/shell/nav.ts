import { G } from '@keith/ui/tokens'

export interface NavItem {
  id: string
  label: string
  glyph: string
  /** Path under the base; `/` for Home. */
  path: string
  /** Shown in the bottom tab bar of a phone (the rest sit under More). */
  tab: boolean
  /** Whether the screen exists; the others show "coming in a later phase". */
  built: boolean
}

export const NAV: readonly NavItem[] = [
  { id: 'home', label: 'Home', glyph: '✳', path: '/', tab: true, built: true },
  { id: 'chat', label: 'Chat', glyph: G.prompt, path: '/chat', tab: true, built: true },
  { id: 'tasks', label: 'Tasks', glyph: G.working, path: '/tasks', tab: false, built: true },
  { id: 'rooms', label: 'Rooms', glyph: G.proactive, path: '/rooms', tab: false, built: true },
  { id: 'inbox', label: 'Inbox', glyph: G.waiting, path: '/inbox', tab: true, built: true },
  { id: 'nodes', label: 'Nodes', glyph: G.dot, path: '/nodes', tab: false, built: true },
  { id: 'budget', label: 'Budget', glyph: '$', path: '/budget', tab: false, built: true },
  { id: 'presence', label: 'Presence', glyph: G.idle, path: '/presence', tab: false, built: true },
  { id: 'brain', label: 'Brain', glyph: '◇', path: '/brain', tab: false, built: true },
  { id: 'me', label: 'Me', glyph: '@', path: '/me', tab: false, built: true },
  { id: 'apps', label: 'Apps', glyph: '▣', path: '/apps', tab: false, built: true },
  { id: 'help', label: 'Help', glyph: '?', path: '/help', tab: false, built: true },
  { id: 'manage', label: 'Manage', glyph: '≡', path: '/manage', tab: false, built: true },
]

/** The phone's last tab: the items that do not fit the bar. */
export const MORE: NavItem = {
  id: 'more',
  label: 'More',
  glyph: G.ellipsis,
  path: '/more',
  tab: true,
  built: true,
}

export const TABS: readonly NavItem[] = [...NAV.filter((i) => i.tab), MORE]

export const hrefOf = (base: string, item: NavItem): string =>
  item.path === '/' ? `${base}/` : `${base}${item.path}`

/** Home matches its own path only; every other item matches itself and what is below it. */
export function isActive(base: string, pathname: string, item: NavItem): boolean {
  const href = hrefOf(base, item)
  if (item.path === '/') return pathname === href || pathname === base
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** The nav item of a section name in the URL (`/app/tasks` is `tasks`), or `undefined` for an unknown one. */
export const itemOf = (id: string): NavItem | undefined => NAV.find((i) => i.id === id)
