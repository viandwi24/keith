import {
  BRAIN_REGIONS,
  countNodes,
  headerSpend,
  isActive,
  type RegionView,
  sortNodes,
  spendTone,
  statusIcon,
  statusTone,
  type Tone,
} from '@keith/app-model'
import type { BrainRegion, BudgetStatus, Node, Task, TaskStatus } from '@keith/contracts'

// View models of the live data (Home's summary cards and the inspector): plain data in, plain rows out.

const LABEL: Partial<Record<BrainRegion, string>> = { 'corpus-callosum': 'Rooms' }
const titled = (r: string): string => r.charAt(0).toUpperCase() + r.slice(1)
export const regionLabel = (region: BrainRegion): string => LABEL[region] ?? titled(region)

export interface LampRow {
  region: BrainRegion
  label: string
  lamp: RegionView['lamp']
  /** `×n` after the name: the running workers (cortex) or the approvals waiting (amygdala); 0 shows nothing. */
  count: number
}

/**
 * The eleven region lamps in the TUI's order. The cortex carries its running workers; the amygdala carries the approvals that wait
 * for an answer and counts as working while any wait.
 */
export function lampRows(view: readonly RegionView[], approvalsWaiting = 0): LampRow[] {
  const byRegion = new Map(view.map((v) => [v.region, v]))
  return BRAIN_REGIONS.map((region) => {
    const v = byRegion.get(region)
    const waiting = region === 'amygdala' ? approvalsWaiting : 0
    return {
      region,
      label: regionLabel(region),
      lamp: waiting > 0 ? 'working' : (v?.lamp ?? 'idle'),
      count: region === 'amygdala' ? waiting : (v?.count ?? 0),
    }
  })
}

export interface BudgetBar {
  /** 0 to 100, or undefined when there is no limit. */
  percent: number | undefined
  tone: 'warning' | 'danger' | undefined
  /** `$3.21 / $20 this month`. */
  text: string
  /** The 80 % warning (or the reached line); undefined below 80 %. */
  warning: string | undefined
}

export function budgetBar(budget: BudgetStatus | undefined): BudgetBar | undefined {
  if (budget === undefined) return undefined
  const limit = budget.limitUsd
  const percent =
    limit === null || limit <= 0
      ? undefined
      : Math.min(100, Math.max(0, Math.round((budget.spentUsd / limit) * 100)))
  const tone = spendTone(budget)
  return {
    percent,
    tone,
    text: headerSpend(budget),
    warning:
      tone === 'danger'
        ? 'limit reached'
        : tone === 'warning'
          ? 'over 80% of the limit'
          : undefined,
  }
}

export interface NodeRow {
  id: string
  name: string
  online: boolean
  label: 'online' | 'offline'
}

/** Online first; revoked nodes are history and not listed. */
export function nodeRows(nodes: readonly Node[]): NodeRow[] {
  return sortNodes(nodes)
    .filter((n) => n.status !== 'revoked')
    .map((n) => ({
      id: n.id,
      name: n.name,
      online: n.status === 'online',
      label: n.status === 'online' ? 'online' : 'offline',
    }))
}

export interface TaskRow {
  id: string
  label: string
  status: TaskStatus
  icon: string
  tone: Tone
}

/** The running tasks (queued, running, waiting), newest board order, at most `limit`. */
export function taskRows(tasks: readonly Task[], limit = 5): TaskRow[] {
  return tasks
    .filter(isActive)
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      label: `${t.agent}: ${t.description}`,
      status: t.status,
      icon: statusIcon(t.status),
      tone: statusTone(t.status),
    }))
}

export interface SummaryCard {
  id: 'tasks' | 'nodes' | 'budget' | 'approvals'
  label: string
  value: string
  detail: string
  /** Path under the app base. */
  path: string
  tone: 'warning' | 'danger' | undefined
}

export interface SummaryInput {
  tasks: readonly Task[]
  nodes: readonly Node[]
  budget: BudgetStatus | undefined
  approvals: number
}

/** The four cards under the orb; each links to its page. */
export function summaryCards({ tasks, nodes, budget, approvals }: SummaryInput): SummaryCard[] {
  const running = tasks.filter(isActive).length
  const { online, total } = countNodes(nodes)
  const bar = budgetBar(budget)
  return [
    {
      id: 'tasks',
      label: 'Tasks',
      value: `${running} running`,
      detail: `${tasks.length} on the board`,
      path: '/tasks',
      tone: undefined,
    },
    {
      id: 'nodes',
      label: 'Nodes',
      value: `${online} of ${total} online`,
      detail: total === 0 ? 'none paired' : 'paired devices',
      path: '/nodes',
      tone: undefined,
    },
    {
      id: 'budget',
      label: 'Budget',
      value:
        bar?.percent === undefined
          ? bar === undefined
            ? 'no data'
            : 'no limit'
          : `${bar.percent}%`,
      detail: bar?.text ?? 'not loaded yet',
      path: '/budget',
      tone: bar?.tone,
    },
    {
      id: 'approvals',
      label: 'Approvals',
      value: approvals === 0 ? 'none waiting' : `${approvals} waiting`,
      detail: approvals === 0 ? 'all clear' : 'needs an answer',
      path: '/inbox',
      tone: approvals > 0 ? 'warning' : undefined,
    },
  ]
}
