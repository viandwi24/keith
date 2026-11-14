import { deliveriesRepo } from '@keith/db'
import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS
/** Failed rows named in the hint; the rest is counted. */
const LISTED = 5

interface FailedRow {
  source: string
  recipient_id: string
  reason: string | null
}

/**
 * The delivery service (docs/specs/delivery.md, "Data"): a `pending` row older than an hour means the core has not
 * delivered it on its retry tick (a `!` line with the count). `failed` rows of the last 7 days are named in the hint
 * (source, recipient, reason; never the text, which a failed row keeps only until its purge). Read only, like the
 * other checks: the database opens read only and nothing is written.
 */
export const deliveryCheck: DoctorCheck = (ctx) => {
  if (ctx.checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const sqlite = openReadOnlyDatabase(ctx.config.dbFile)
  try {
    const now = Date.now()
    const stale = deliveriesRepo(sqlite).pendingBefore(now - HOUR_MS)
    const failed = sqlite
      .query<FailedRow, [number]>(
        `SELECT source, recipient_id, reason FROM deliveries
          WHERE status = 'failed' AND updated_at >= ? ORDER BY updated_at DESC`,
      )
      .all(now - WEEK_MS)
    if (stale === 0 && failed.length === 0) return []
    const parts: string[] = []
    if (stale > 0)
      parts.push(
        `${stale} pending delivery ${stale === 1 ? 'row' : 'rows'} older than an hour: the core retries them on its tick, check that it runs`,
      )
    if (failed.length > 0) {
      const listed = failed
        .slice(0, LISTED)
        .map((r) => `${r.source} to ${r.recipient_id} (${r.reason ?? 'unknown'})`)
      const more = failed.length > LISTED ? `, and ${failed.length - LISTED} more` : ''
      parts.push(`${failed.length} failed in the last 7 days: ${listed.join('; ')}${more}`)
    }
    const line: Check = { level: 'warn', name: 'delivery', hint: parts.join('; ') }
    return [line]
  } finally {
    sqlite.close()
  }
}
