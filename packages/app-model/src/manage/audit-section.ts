import type { AuditEvent } from '@keith/contracts'
import type { Row, SectionEnv, SectionModel } from './types.ts'

const AUDIT_LIMIT = 100

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/** The row of an audit event; the detail is its JSON, clipped by the screen. */
export const auditRow = (e: AuditEvent): Row => ({
  id: String(e.id),
  cells: [when(e.at), e.kind, e.actor, e.via],
  detail: JSON.stringify(e.detail),
  actions: [],
})

/** Audit: the last events, newest first (`admin.audit.list`), read only. */
export function auditSection(env: SectionEnv) {
  const load = () => env.client.rpc.admin.audit.list({ limit: env.limit ?? AUDIT_LIMIT })
  return {
    load,
    build: (events) => ({
      lines: [],
      header: ['TIME (UTC)', 'EVENT', 'ACTOR', 'VIA'],
      widths: [20, 22, 16],
      rows: (events ?? []).map(auditRow),
      empty: 'No events yet.',
      actions: [],
    }),
  } satisfies SectionModel<Awaited<ReturnType<typeof load>>>
}
