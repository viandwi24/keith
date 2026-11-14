import type { AuditRepo, AuditVia } from '@keith/db'

/** Records one security event. Never throws: an audit failure must not break the action. */
export interface Audit {
  record(event: {
    kind: string
    actor: string
    via: AuditVia
    detail?: Record<string, unknown>
  }): void
}

/** The audit log over its repo; a failed write goes to `warn` and nowhere else. */
export function createAudit(repo: AuditRepo, warn?: (message: string) => void): Audit {
  return {
    record(event) {
      try {
        repo.add(event)
      } catch (error) {
        warn?.(
          `audit: could not record ${event.kind}: ${error instanceof Error ? error.message : error}`,
        )
      }
    },
  }
}

/** An audit that records nothing (tests of parts that do not care). */
export const noAudit: Audit = { record() {} }

/** `record(kind, detail)` already bound to who did it and how: what an rpc call context carries. */
export type RecordAudit = (kind: string, detail?: Record<string, unknown>) => void
