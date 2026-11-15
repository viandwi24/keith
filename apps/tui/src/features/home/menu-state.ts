import type { BudgetStatus, Health, ModelRoles, Node, Task, Whoami } from '@keith/contracts'
import type { ConnectionKind } from '@keith/ui'
import type { BrainState } from '../brain/index.ts'
import { headerSpend, spendTone } from '../budget/index.ts'
import { countNodes } from '../nodes/index.ts'
import { isActive } from '../tasks/index.ts'

// The two-level menu (menuTree and its types) lives in `@keith/app-model` (shared with the web's command palette).
export {
  isGroup,
  type MenuEntry,
  type MenuGroup,
  type MenuItem,
  type MenuTarget,
  menuTree,
  moveMenu,
  opensDirectly,
  type ViewEntry,
} from '@keith/app-model'

import type { MenuItem } from '@keith/app-model'

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
