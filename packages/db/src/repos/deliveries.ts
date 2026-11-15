// The `deliveries` table (docs/specs/delivery.md, "Data"). Policy (routes, retries, the failure notice) is the core's:
// this repo stores rows and answers the questions the service asks. Pruning of finished rows is in retention.ts.
import type { Sqlite } from '../eh/sql.ts'

export type DeliveryStatus = 'pending' | 'held' | 'delivered' | 'failed'

export interface DeliveryRecord {
  id: string
  source: string
  recipientId: string
  billTo: string | null
  name: string
  /** The request's `needs`, as JSON text. */
  needs: string
  /** The request's `data`, as JSON text, or null. */
  data: string | null
  /** The message text; empty once the row is delivered. */
  text: string
  reportTo: string | null
  reportText: string | null
  reportKey: string | null
  status: DeliveryStatus
  reason: string | null
  attempts: number
  nextAttemptAt: number | null
  route: string | null
  createdAt: number
  updatedAt: number
}

/** A new pending row. The repo sets the timestamps and the pending state. */
export interface NewDelivery {
  id: string
  source: string
  recipientId: string
  billTo?: string | null
  name: string
  needs: string
  data?: string | null
  text: string
  reportTo?: string | null
  reportText?: string | null
  reportKey?: string | null
  /** When the first attempt is due (the creation time when omitted). */
  nextAttemptAt?: number
}

/** The state a row moves to. `delivered` blanks the text. */
export interface DeliveryPatch {
  status: DeliveryStatus
  reason?: string | null
  attempts: number
  nextAttemptAt?: number | null
  route?: string | null
}

export interface DeliveriesRepo {
  /**
   * Inserts a pending row, or returns the stored row of the same id with `created: false`. One statement, so two
   * callers with the same run id see one row (the exactly-once guard of the service).
   */
  create(input: NewDelivery): { created: boolean; record: DeliveryRecord }
  get(id: string): DeliveryRecord | undefined
  /** Pending rows whose next attempt is due (at or before `now`), oldest due first. */
  due(now: number, limit: number): DeliveryRecord[]
  /** Moves a row to `patch`; false when no row has the id. */
  settle(id: string, patch: DeliveryPatch): boolean
  /** Pending rows of a recipient, oldest first (the removal registry lists their ids). */
  pendingFor(recipientId: string): DeliveryRecord[]
  /** Deletes the pending rows of a recipient; returns how many (removal with `purge`). */
  deletePendingFor(recipientId: string): number
  /** Held rows of a recipient (kept for the return digest), oldest first, at most `limit`. */
  heldFor(recipientId: string, limit?: number): DeliveryRecord[]
  /** The recipients that have held rows. */
  heldRecipients(): string[]
  /** Held rows created before `before`, oldest first (the 7-day release). */
  heldBefore(before: number, limit: number): DeliveryRecord[]
  /** Deletes the held rows of a recipient; returns how many (removal with `purge`). */
  deleteHeldFor(recipientId: string): number
  /** Pending rows created before `before` (doctor: stale rows). */
  pendingBefore(before: number): number
}

interface Row {
  id: string
  source: string
  recipient_id: string
  bill_to: string | null
  name: string
  needs: string
  data: string | null
  text: string
  report_to: string | null
  report_text: string | null
  report_key: string | null
  status: string
  reason: string | null
  attempts: number
  next_attempt_at: number | null
  route: string | null
  created_at: number
  updated_at: number
}

const toRecord = (r: Row): DeliveryRecord => ({
  id: r.id,
  source: r.source,
  recipientId: r.recipient_id,
  billTo: r.bill_to,
  name: r.name,
  needs: r.needs,
  data: r.data,
  text: r.text,
  reportTo: r.report_to,
  reportText: r.report_text,
  reportKey: r.report_key,
  status: r.status as DeliveryStatus,
  reason: r.reason,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  route: r.route,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function deliveriesRepo(
  sqlite: Sqlite,
  options: { now?: () => number } = {},
): DeliveriesRepo {
  const now = options.now ?? Date.now
  return {
    create(input) {
      const at = now()
      const inserted = sqlite
        .query(
          `INSERT OR IGNORE INTO deliveries (id, source, recipient_id, bill_to, name, needs, data, text,
             report_to, report_text, report_key, status, reason, attempts, next_attempt_at, route, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.source,
          input.recipientId,
          input.billTo ?? null,
          input.name,
          input.needs,
          input.data ?? null,
          input.text,
          input.reportTo ?? null,
          input.reportText ?? null,
          input.reportKey ?? null,
          input.nextAttemptAt ?? at,
          at,
          at,
        )
      const row = sqlite.query<Row, [string]>('SELECT * FROM deliveries WHERE id = ?').get(input.id)
      if (row === null) throw new Error(`deliveries: row ${input.id} vanished after insert`)
      return { created: inserted.changes > 0, record: toRecord(row) }
    },
    get(id) {
      const row = sqlite.query<Row, [string]>('SELECT * FROM deliveries WHERE id = ?').get(id)
      return row === null ? undefined : toRecord(row)
    },
    due(at, limit) {
      return sqlite
        .query<Row, [number, number]>(
          `SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at, id LIMIT ?`,
        )
        .all(at, limit)
        .map(toRecord)
    },
    settle(id, patch) {
      const changes = sqlite
        .query(
          `UPDATE deliveries SET status = ?, reason = ?, attempts = ?, next_attempt_at = ?, route = ?,
             text = CASE WHEN ? = 'delivered' THEN '' ELSE text END, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.status,
          patch.reason ?? null,
          patch.attempts,
          patch.nextAttemptAt ?? null,
          patch.route ?? null,
          patch.status,
          now(),
          id,
        ).changes
      return changes > 0
    },
    pendingFor(recipientId) {
      return sqlite
        .query<Row, [string]>(
          `SELECT * FROM deliveries WHERE recipient_id = ? AND status = 'pending' ORDER BY created_at, id`,
        )
        .all(recipientId)
        .map(toRecord)
    },
    deletePendingFor(recipientId) {
      return sqlite
        .query(`DELETE FROM deliveries WHERE recipient_id = ? AND status = 'pending'`)
        .run(recipientId).changes
    },
    heldFor(recipientId, limit = 1000) {
      return sqlite
        .query<Row, [string, number]>(
          `SELECT * FROM deliveries WHERE recipient_id = ? AND status = 'held' ORDER BY created_at, id LIMIT ?`,
        )
        .all(recipientId, limit)
        .map(toRecord)
    },
    heldRecipients() {
      return sqlite
        .query<{ recipient_id: string }, []>(
          `SELECT DISTINCT recipient_id FROM deliveries WHERE status = 'held' ORDER BY recipient_id`,
        )
        .all()
        .map((r) => r.recipient_id)
    },
    heldBefore(before, limit) {
      return sqlite
        .query<Row, [number, number]>(
          `SELECT * FROM deliveries WHERE status = 'held' AND created_at < ? ORDER BY created_at, id LIMIT ?`,
        )
        .all(before, limit)
        .map(toRecord)
    },
    deleteHeldFor(recipientId) {
      return sqlite
        .query(`DELETE FROM deliveries WHERE recipient_id = ? AND status = 'held'`)
        .run(recipientId).changes
    },
    pendingBefore(before) {
      return (
        sqlite
          .query<{ n: number }, [number]>(
            `SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending' AND created_at < ?`,
          )
          .get(before)?.n ?? 0
      )
    },
  }
}
