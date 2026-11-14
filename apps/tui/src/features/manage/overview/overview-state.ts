import type { BudgetStatus, Health, ModelRoles, Node, Whoami } from '@keith/contracts'
import { usd } from '../budget/budget-state.ts'

export interface OverviewInput {
  me: Whoami
  health: Health | undefined
  roles: ModelRoles | undefined
  budget: BudgetStatus | undefined
  nodes: readonly Node[] | undefined
  people: number | undefined
  pendingDevices: number | undefined
}

/** The overview rows: who you are, the core, the front model, spend, and what waits for you. */
export function overviewLines(o: OverviewInput): string[] {
  const lines = [
    `you       ${o.me.name} (${o.me.role}) via ${o.me.via === 'local' ? 'the local socket' : 'a remote login'}`,
  ]
  if (o.health !== undefined) lines.push(`core      ${o.health.version} (${o.health.sha})`)
  if (o.roles !== undefined)
    lines.push(
      `models    front ${o.roles.front ?? '(not set)'} · cortex ${o.roles.cortex ?? '(not set)'}`,
    )
  if (o.budget !== undefined) {
    const limit = o.budget.limitUsd === null ? 'no limit' : `of ${usd(o.budget.limitUsd)}`
    lines.push(`budget    ${usd(o.budget.spentUsd)} spent this month, ${limit}`)
  }
  if (o.nodes !== undefined) {
    const live = o.nodes.filter((n) => n.status === 'online').length
    lines.push(`nodes     ${live} online of ${o.nodes.length}`)
  }
  if (o.people !== undefined) lines.push(`people    ${o.people}`)
  if (o.pendingDevices !== undefined)
    lines.push(
      `devices   ${o.pendingDevices === 0 ? 'no login waits for approval' : `${o.pendingDevices} login(s) wait for approval`}`,
    )
  return lines
}
