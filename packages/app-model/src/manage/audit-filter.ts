import type { AuditEvent } from '@keith/contracts'

// The Audit section's filters (web): the core lists the newest events, so kind, actor, route and a word are narrowed here, over what was
// read. Pure.

export interface AuditFilter {
  /** An event kind (`auth.login`), or empty for all. */
  kind: string
  actor: string
  /** The listener the call came through (`local`, `tcp`), or empty for all. */
  via: string
  /** A word the kind, actor or detail must hold (case aside). */
  q: string
}

export const NO_AUDIT_FILTER: AuditFilter = { kind: '', actor: '', via: '', q: '' }

export const isFiltered = (f: AuditFilter): boolean =>
  f.kind !== '' || f.actor !== '' || f.via !== '' || f.q.trim() !== ''

/** The events that pass every filter, in the order given. */
export function filterAudit(events: readonly AuditEvent[], f: AuditFilter): AuditEvent[] {
  const q = f.q.trim().toLowerCase()
  return events.filter((e) => {
    if (f.kind !== '' && e.kind !== f.kind) return false
    if (f.actor !== '' && e.actor !== f.actor) return false
    if (f.via !== '' && e.via !== f.via) return false
    if (q === '') return true
    return `${e.kind} ${e.actor} ${JSON.stringify(e.detail)}`.toLowerCase().includes(q)
  })
}

/** The distinct values of one field, sorted: what the filter's choices offer. */
export function auditChoices(
  events: readonly AuditEvent[],
  field: 'kind' | 'actor' | 'via',
): string[] {
  return [...new Set(events.map((e) => e[field]))].sort()
}
