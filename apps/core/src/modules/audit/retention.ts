import type { AuditRepo, AuditVia, SettingsRepo } from '@keith/db'
import type { Audit } from './audit.ts'

/** Setting key: how many days of audit to keep. 0 keeps everything. */
export const AUDIT_RETENTION_KEY = 'audit.retentionDays'
export const DEFAULT_AUDIT_RETENTION_DAYS = 180
/** The longest retention (ten years); a larger value in the store is read as the default. */
export const MAX_AUDIT_RETENTION_DAYS = 3650

const DAY_MS = 86_400_000

export interface AuditRetention {
  /** The days in force: the stored setting, else 180. A corrupt value reads as the default, never as "forever". */
  days(): number
  /** Stores the setting (0 = keep everything). Throws `RangeError` outside 0..3650 or for a non-integer. */
  setDays(days: number): void
  /**
   * Deletes the rows older than the retention and, when any went, records one `audit.pruned` row
   * (`actor: system`, `via` as given, detail `{ deleted, retentionDays }`). Returns how many went.
   */
  prune(): number
}

export function createAuditRetention(options: {
  repo: AuditRepo
  settings: SettingsRepo
  audit: Audit
  /** Where the prune runs: `local` for the running core (compose), `offline` for a stopped one. */
  via: AuditVia
  now?: () => number
}): AuditRetention {
  const now = options.now ?? Date.now
  const days = (): number => {
    const stored = options.settings.get<unknown>(AUDIT_RETENTION_KEY)
    if (stored === undefined) return DEFAULT_AUDIT_RETENTION_DAYS
    return Number.isInteger(stored) &&
      (stored as number) >= 0 &&
      (stored as number) <= MAX_AUDIT_RETENTION_DAYS
      ? (stored as number)
      : DEFAULT_AUDIT_RETENTION_DAYS
  }
  return {
    days,
    setDays(value) {
      if (!Number.isInteger(value) || value < 0 || value > MAX_AUDIT_RETENTION_DAYS) {
        throw new RangeError(`audit retention is 0 to ${MAX_AUDIT_RETENTION_DAYS} days`)
      }
      options.settings.set(AUDIT_RETENTION_KEY, value)
    },
    prune() {
      const keep = days()
      if (keep === 0) return 0
      const deleted = options.repo.prune(now() - keep * DAY_MS)
      if (deleted > 0) {
        options.audit.record({
          kind: 'audit.pruned',
          actor: 'system',
          via: options.via,
          detail: { deleted, retentionDays: keep },
        })
      }
      return deleted
    },
  }
}
