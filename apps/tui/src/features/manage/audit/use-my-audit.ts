import type { MyAuditEvent } from '@keith/contracts'
import type { ManageEnv, Row, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'

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
export function useMyAudit(env: ManageEnv): SectionData {
  const load = useLoad(() => env.client.audit.mine({ limit: PAGE }))
  return {
    lines: [],
    header: ['WHEN (UTC)', 'WHO', 'WHAT'],
    widths: [20, 16],
    rows: (load.data ?? []).map(myAuditRow),
    empty: 'Nobody looked at your things. Lines appear here the moment someone does.',
    actions: [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
