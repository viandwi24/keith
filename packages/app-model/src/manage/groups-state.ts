import type { GroupMember, GroupView, Person } from '@keith/contracts'
import type { Row } from './types.ts'

export const GROUPS_HEADER = ['GROUP', 'MEMBERS', 'USED BY'] as const
export const GROUPS_WIDTHS = [20, 9] as const

/** How a member is named in a call and in a sentence: the username, else the id. */
export const memberLabel = (m: Pick<GroupMember, 'username' | 'id'>): string => m.username ?? m.id

const resources = (n: number): string => `${n} resource${n === 1 ? '' : 's'}`

/** The row of a group; `actions` are filled in by the hook. The detail names the members. */
export function groupRow(g: GroupView, actions: Row['actions']): Row {
  const names = g.members.map(memberLabel)
  return {
    id: g.id,
    cells: [g.name, String(g.members.length), g.usage === 0 ? '-' : resources(g.usage)],
    detail: names.length === 0 ? 'no members yet' : `members ${names.join(', ')}`,
    actions,
  }
}

/** The people who can still be added to a group: active, and not in it already. */
export function addable(g: GroupView, people: readonly Person[]): string[] {
  const inside = new Set(g.members.map((m) => m.id))
  return people
    .filter((p) => p.status === 'active' && !inside.has(p.id))
    .map((p) => p.username ?? p.id)
}
