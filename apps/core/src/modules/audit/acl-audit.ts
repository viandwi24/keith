import {
  ACL_AUDIT_KINDS,
  AclAuditDetailSchemas,
  type AclAuditKind,
  OWNER_ACCESS_MAX_IDS,
} from '@keith/contracts'
import type { AuditVia } from '@keith/db'
import type { Audit } from './audit.ts'

/** One window of the owner-access dedupe and the deny counter (docs/specs/acl.md, "Audit"). */
export const ACL_AUDIT_WINDOW_MS = 10 * 60_000
/** The most keys held for the windows; the oldest go first, so memory stays bounded. */
const MAX_KEYS = 10_000

/** Who looked, and through which listener. `session` is the credential or session id, else the person id. */
export interface AclAuditCaller {
  /** The person id of the actor (for owner-access: the instance owner). */
  by: string
  via: AuditVia
  session?: string | null
}

export interface AclAudit {
  /** A change that succeeded: create, share, unshare, chmod, chown, remove, group.*. Unknown detail keys are dropped. */
  record(
    kind: Exclude<AclAuditKind, 'acl.owner-access' | 'acl.deny'>,
    caller: AclAuditCaller,
    detail: Record<string, unknown>,
  ): void
  /**
   * The instance owner read resources that are not theirs and that the rules alone would not give them.
   * At most one row per (session, kind, resource) per window; a batch that touches many resources writes one
   * row per resource owner, listing the first 20 new ids and the full count, never any content. Returns the rows written.
   */
  ownerAccess(
    caller: AclAuditCaller,
    access: { kind: string; bits: number; resources: { id: string; owner: string }[] },
  ): number
  /** A denied read: counted, not logged one by one. The first one of a window per (session, kind) writes a row. */
  denied(caller: AclAuditCaller, kind: string): void
  /** Writes the counts still held back (at shutdown, and in tests). */
  flush(): void
}

/** Recorder of the ACL audit kinds. Never throws: the audit must not break the action. */
export function createAclAudit(options: {
  audit: Audit
  now?: () => number
  windowMs?: number
  warn?: (message: string) => void
}): AclAudit {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? ACL_AUDIT_WINDOW_MS
  /** key -> end of its window */
  const seen = new Map<string, number>()
  /** `session|kind` -> the open deny window */
  const denies = new Map<
    string,
    { until: number; count: number; suppressed: number; caller: AclAuditCaller; kind: string }
  >()

  const trim = () => {
    if (seen.size <= MAX_KEYS) return
    const t = now()
    for (const [k, until] of seen) if (until <= t) seen.delete(k)
    for (const k of seen.keys()) {
      if (seen.size <= MAX_KEYS) break
      seen.delete(k)
    }
  }
  const row = (kind: AclAuditKind, caller: AclAuditCaller, detail: Record<string, unknown>) => {
    const parsed = AclAuditDetailSchemas[kind].safeParse(detail)
    if (!parsed.success) {
      options.warn?.(`acl audit: bad detail for ${kind}`)
      options.audit.record({ kind, actor: caller.by, via: caller.via, detail: { invalid: true } })
      return
    }
    options.audit.record({
      kind,
      actor: caller.by,
      via: caller.via,
      detail: parsed.data as Record<string, unknown>,
    })
  }
  const sessionOf = (c: AclAuditCaller) => c.session ?? c.by

  return {
    record(kind, caller, detail) {
      if (!(ACL_AUDIT_KINDS as readonly string[]).includes(kind)) return
      row(kind, caller, detail)
    },
    ownerAccess(caller, access) {
      const t = now()
      const fresh = new Map<string, string[]>() // owner -> new ids
      for (const r of access.resources) {
        const key = `${sessionOf(caller)}|${access.kind}|${r.id}`
        const until = seen.get(key)
        if (until !== undefined && until > t) continue
        seen.set(key, t + windowMs)
        const ids = fresh.get(r.owner) ?? []
        ids.push(r.id)
        fresh.set(r.owner, ids)
      }
      trim()
      let written = 0
      for (const [owner, ids] of fresh) {
        const [first] = ids
        row(
          'acl.owner-access',
          caller,
          ids.length === 1 && first !== undefined
            ? { kind: access.kind, id: first, owner, bits: access.bits }
            : {
                kind: access.kind,
                ids: ids.slice(0, OWNER_ACCESS_MAX_IDS),
                count: ids.length,
                owner,
                bits: access.bits,
              },
        )
        written++
      }
      return written
    },
    denied(caller, kind) {
      const t = now()
      const key = `${sessionOf(caller)}|${kind}`
      const open = denies.get(key)
      if (open !== undefined && open.until > t) {
        open.count++
        open.suppressed++
        return
      }
      const suppressed = open === undefined ? 0 : open.suppressed
      denies.delete(key) // re-insert last: Map order is the age order
      denies.set(key, { until: t + windowMs, count: 1, suppressed: 0, caller, kind })
      while (denies.size > MAX_KEYS) {
        const oldest = denies.keys().next().value
        if (oldest === undefined) break
        denies.delete(oldest)
      }
      row('acl.deny', caller, { kind, count: 1, suppressed })
    },
    flush() {
      for (const [key, open] of denies) {
        if (open.suppressed > 0) {
          row('acl.deny', open.caller, {
            kind: open.kind,
            count: open.count,
            suppressed: open.suppressed,
          })
        }
        denies.delete(key)
      }
    },
  }
}
