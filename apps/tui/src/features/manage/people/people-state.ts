import type { Person } from '@keith/contracts'
import { G } from '@keith/ui'
import type { Row } from '../manage-types.ts'

export const PEOPLE_HEADER = ['USERNAME', 'NAME', 'ROLE', 'STATUS'] as const
export const PEOPLE_WIDTHS = [16, 18, 8] as const

const STATUS_GLYPH: Record<string, string> = {
  active: G.dot,
  suspended: G.working,
  removed: G.idle,
}

/** How a person is named in a call and in a sentence: the username, else the id. */
export const personLabel = (p: Person): string => p.username ?? p.id

/** The row of a person; `actions` are filled in by the hook. */
export function personRow(p: Person, actions: Row['actions']): Row {
  return {
    id: p.id,
    cells: [
      personLabel(p),
      p.name,
      p.role,
      `${STATUS_GLYPH[p.status] ?? G.idle} ${p.status}${p.canLogin ? '' : ', no sign-in'}`,
    ],
    ...(p.status === 'active'
      ? {}
      : { tone: p.status === 'suspended' ? ('warning' as const) : ('muted' as const) }),
    detail: `id ${p.id}`,
    actions,
  }
}

/** Which of the person actions apply to this person (the owner is never suspended, removed or replaced here). */
export function personKinds(p: Person): {
  suspend: boolean
  reactivate: boolean
  remove: boolean
  transfer: boolean
  role: boolean
} {
  const owner = p.role === 'owner'
  return {
    suspend: !owner && p.status === 'active',
    reactivate: !owner && p.status === 'suspended',
    remove: !owner,
    transfer: !owner && p.status === 'active',
    role: !owner,
  }
}
