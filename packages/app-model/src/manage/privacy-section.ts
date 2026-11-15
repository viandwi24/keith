import type { MyAuditEvent } from '@keith/contracts'
import type { Row, SectionEnv, SectionModel } from './types.ts'

const PAGE = 100

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/** The row of a line about the person: when, who, what. No address, no listener: the core never sends them. */
export const myAuditRow = (e: MyAuditEvent): Row => ({
  id: String(e.id),
  cells: [when(e.at), e.actorName, e.summary],
  actions: [],
})

/**
 * Privacy: what others did with the person's things, newest first (`admin.audit.mine`, every person). The
 * owner's looks at a member's notes are here, so the promise of docs/sharing-and-privacy.md is a screen.
 */
export function privacySection(env: SectionEnv) {
  const load = () => env.client.audit.mine({ limit: env.limit ?? PAGE })
  return {
    load,
    build: (events) => ({
      lines: [],
      header: ['WHEN (UTC)', 'WHO', 'WHAT'],
      widths: [20, 16],
      rows: (events ?? []).map(myAuditRow),
      empty: 'Nobody looked at your things. Lines appear here the moment someone does.',
      actions: [],
    }),
  } satisfies SectionModel<Awaited<ReturnType<typeof load>>>
}
