import type { BudgetStatus, Health, ModelRoles, Node, Task, Whoami } from '@keith/contracts'
import type { ConnectionKind } from '@keith/ui'
import type { BrainState } from '../brain/index.ts'
import { headerSpend, spendTone } from '../budget/index.ts'
import { countNodes } from '../nodes/index.ts'
import { isActive } from '../tasks/index.ts'

/** Where `right` (or `enter` on a screen item) goes. */
export type MenuTarget =
  | { kind: 'section'; index: number }
  | { kind: 'tasks' }
  | { kind: 'trace' }
  | { kind: 'help' }
  /** End this session (`/logout`): the one entry that stays available while the core is unreachable. */
  | { kind: 'logout' }
  /** A plugin's terminal view (`plugin-view`): `enter` or `right` opens it. */
  | { kind: 'view'; viewId: string; label: string }

export interface MenuItem {
  /** A manage section id, or `tasks`, `trace`, `help`. */
  id: string
  title: string
  target: MenuTarget
  /** `flag`: something here needs a look (the month's spend is near or over its limit), shown as `!`. */
  flag?: '!'
}

/** A row that opens a submenu (drawn with a trailing `▸`); it is not a target itself. */
export interface MenuGroup {
  id: string
  title: string
  children: readonly MenuItem[]
  flag?: '!'
}

export type MenuEntry = MenuItem | MenuGroup

export const isGroup = (e: MenuEntry): e is MenuGroup => 'children' in e

/** A plugin view the core listed for this person (`GET /plugins/tui/menu`): its wire id and label. */
export interface ViewEntry {
  viewId: string
  label: string
}

/** Which group a manage section lives in (an unknown id lands in System); Overview is a leaf. */
const GROUP_OF: Record<string, string> = {
  people: 'people-access',
  groups: 'people-access',
  devices: 'people-access',
  access: 'people-access',
  succession: 'people-access',
  plugins: 'apps',
  reviews: 'apps',
  protocols: 'apps',
  providers: 'models-budget',
  budget: 'models-budget',
}
const GROUP_TITLES: readonly (readonly [string, string])[] = [
  ['people-access', 'People & access'],
  ['apps', 'Apps'],
  ['models-budget', 'Models & budget'],
  ['system', 'System'],
]
/** Order inside a group (ids not listed keep the sections' order, after the listed ones). */
const CHILD_ORDER: Record<string, readonly string[]> = {
  'people-access': ['people', 'groups', 'devices', 'access', 'succession'],
  apps: ['plugins', 'reviews', 'protocols'],
  'models-budget': ['providers', 'budget'],
  system: ['nodes', 'privacy', 'audit'],
}

/**
 * The two-level menu: Overview, People & access, Apps (the plugin views, then Plugins and Reviews),
 * Models & budget, System, Help and Logout. A group with nothing in it for this role is left out.
 */
export function menuTree(
  sections: readonly { id: string; title: string }[],
  budget?: BudgetStatus,
  views: readonly ViewEntry[] = [],
  { logout = false }: { logout?: boolean } = {},
): MenuEntry[] {
  const warn = budget !== undefined && spendTone(budget) !== undefined
  const leaf = (s: { id: string; title: string }, index: number): MenuItem => ({
    id: s.id,
    title: s.title,
    target: { kind: 'section', index },
    ...(warn && s.id === 'budget' ? { flag: '!' as const } : {}),
  })
  const all = sections.map(leaf)
  const viewItems: MenuItem[] = views.map((v) => ({
    id: v.viewId,
    title: v.label,
    target: { kind: 'view', viewId: v.viewId, label: v.label },
  }))
  const systemTail: MenuItem[] = [
    { id: 'tasks', title: 'Tasks', target: { kind: 'tasks' } },
    { id: 'trace', title: 'Brain trace', target: { kind: 'trace' } },
  ]
  const groups: MenuGroup[] = []
  for (const [id, title] of GROUP_TITLES) {
    const order = CHILD_ORDER[id] ?? []
    const rank = (i: MenuItem) => (order.includes(i.id) ? order.indexOf(i.id) : order.length)
    const members = all.filter((i) => (GROUP_OF[i.id] ?? 'system') === id && i.id !== 'overview')
    // Apps leads with the plugin views; System puts Tasks and Brain trace after its sections
    const children = [
      ...(id === 'apps' ? viewItems : []),
      ...members.sort((a, b) => rank(a) - rank(b)),
      ...(id === 'system' ? systemTail : []),
    ]
    if (children.length === 0) continue
    groups.push({
      id,
      title,
      children,
      ...(children.some((c) => c.flag !== undefined) ? { flag: '!' as const } : {}),
    })
  }
  const overview = all.find((i) => i.id === 'overview')
  return [
    ...(overview === undefined ? [] : [overview]),
    ...groups,
    { id: 'help', title: 'Help', target: { kind: 'help' } },
    ...(logout ? [{ id: 'logout', title: 'Logout', target: { kind: 'logout' } } as const] : []),
  ]
}

/** Tasks, Brain trace and Help have no detail box: `enter` opens them. */
export const opensDirectly = (item: MenuItem): boolean => item.target.kind !== 'section'

export const moveMenu = (index: number, delta: -1 | 1, total: number): number =>
  total <= 0 ? 0 : (index + delta + total) % total

/** What the app already knows; a summary never asks the core for more. */
export interface SummaryData {
  me: Whoami | undefined
  connection: ConnectionKind
  health: Health | undefined
  roles: ModelRoles | undefined
  budget: BudgetStatus | undefined
  nodes: readonly Node[]
  tasks: readonly Task[]
  brain: BrainState
}

const CONNECTION_WORD: Record<ConnectionKind, string> = {
  connecting: 'connecting',
  live: 'online',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
  'logged-out': 'logged out',
  offline: 'offline',
}

const model = (ref: string | null | undefined): string => ref?.split('/').at(-1) ?? 'not set'

const STATIC: Record<string, string[]> = {
  people: ['Who can sign in, and their roles.'],
  succession: ['The heir who takes over if you are gone.', 'window, pause and last sign'],
  groups: ['Groups of people the owner shares with.'],
  devices: ['Devices and tokens that can reach this core.'],
  access: ['Who may do what: roles and capabilities.'],
  audit: ['The record of sensitive actions.', '→ open'],
  help: ['Keys, commands, and what lives on the core machine.'],
}

/** One to four live lines for the detail box of a menu item, from data the app already holds. */
export function summaryOf(item: MenuItem, data: SummaryData): string[] {
  switch (item.id) {
    case 'overview':
      return [
        `connection ${CONNECTION_WORD[data.connection]}`,
        data.health === undefined
          ? 'core unknown'
          : `core ${data.health.version} ${data.health.status}`,
        data.me === undefined ? 'no identity' : `you ${data.me.name} (${data.me.role})`,
        `front ${model(data.roles?.front)}`,
      ]
    case 'nodes': {
      const { online, total } = countNodes(data.nodes)
      const live = data.nodes.filter((n) => n.status !== 'revoked').slice(0, 3)
      return [`${online} of ${total} online`, ...live.map((n) => `${n.name} ${n.status}`)]
    }
    case 'providers':
      return [`front ${model(data.roles?.front)}`, `cortex ${model(data.roles?.cortex)}`]
    case 'budget':
      if (data.budget === undefined) return ['no budget data yet']
      return [
        headerSpend(data.budget),
        data.budget.remainingUsd === null
          ? 'no limit set'
          : `$${data.budget.remainingUsd.toFixed(2)} left`,
        ...(spendTone(data.budget) === 'danger'
          ? ['! limit reached']
          : spendTone(data.budget) === 'warning'
            ? ['! over 80% of the limit']
            : []),
      ]
    case 'tasks': {
      const running = data.tasks.filter(isActive)
      return [
        `${running.length} running, ${data.tasks.length} total`,
        ...running.slice(0, 2).map((t) => `${t.agent}: ${t.description}`),
      ]
    }
    case 'trace':
      return [
        `${data.brain.cortexActive.length} workers active`,
        data.brain.last === undefined ? 'no activity yet' : data.brain.last.text,
      ]
    default:
      return STATIC[item.id] ?? []
  }
}
