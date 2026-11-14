import { immediate, type Sqlite } from '../eh/sql.ts'

export type ReviewStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ReviewRecord {
  id: string
  requester: string
  plugin: string
  operation: string
  /** The validated input as JSON text. */
  payload: string
  status: ReviewStatus
  reason: string | null
  outcome: string | null
  createdAt: number
  expiresAt: number
  decidedAt: number | null
  decidedBy: string | null
}

export type ReviewCreateResult = { ok: true } | { ok: false; reason: 'cap' }

/** The owner review queue's table (`owner_reviews`). Policy (who may decide, replay, audit) is the core's. */
export interface ReviewsRepo {
  /** Atomic: refuses (a value, not a throw) when the requester already has `cap` pending, unexpired reviews. */
  create(
    input: Pick<
      ReviewRecord,
      'id' | 'requester' | 'plugin' | 'operation' | 'payload' | 'reason'
    > & {
      ttlMs: number
    },
    cap: number,
  ): ReviewCreateResult
  get(id: string): ReviewRecord | undefined
  /** Newest first. */
  list(filter?: { status?: ReviewStatus; requester?: string; limit?: number }): ReviewRecord[]
  /** Atomic: moves a pending, unexpired review to `status`; false when it was not (already decided or expired). */
  decide(id: string, status: 'approved' | 'denied', by: string, reason?: string): boolean
  /** Records what an approved operation did (`ok` or `error:<code>`). */
  setOutcome(id: string, outcome: string): void
  /** Pending reviews past their expiry become `expired`; returns the rows that changed. */
  expire(): ReviewRecord[]
  /** Delete decided or expired reviews decided before `before` (the retention hook, ADR-0027 §19); pending rows stay. Returns how many. */
  purge(before: number): number
}

interface Row {
  id: string
  requester: string
  plugin: string
  operation: string
  payload: string
  status: string
  reason: string | null
  outcome: string | null
  created_at: number
  expires_at: number
  decided_at: number | null
  decided_by: string | null
}

const toRecord = (r: Row): ReviewRecord => ({
  id: r.id,
  requester: r.requester,
  plugin: r.plugin,
  operation: r.operation,
  payload: r.payload,
  status: r.status as ReviewStatus,
  reason: r.reason,
  outcome: r.outcome,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
})

export function reviewsRepo(sqlite: Sqlite, options: { now?: () => number } = {}): ReviewsRepo {
  const now = options.now ?? Date.now
  return {
    create(input, cap) {
      return immediate(sqlite, () => {
        const at = now()
        const n =
          sqlite
            .query<{ n: number }, [string, number]>(
              "SELECT COUNT(*) AS n FROM owner_reviews WHERE requester = ? AND status = 'pending' AND expires_at > ?",
            )
            .get(input.requester, at)?.n ?? 0
        if (n >= cap) return { ok: false, reason: 'cap' }
        sqlite
          .query(
            `INSERT INTO owner_reviews (id, requester, plugin, operation, payload, status, reason, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            input.id,
            input.requester,
            input.plugin,
            input.operation,
            input.payload,
            input.reason,
            at,
            at + input.ttlMs,
          )
        return { ok: true }
      })
    },
    get(id) {
      const row = sqlite.query<Row, [string]>('SELECT * FROM owner_reviews WHERE id = ?').get(id)
      return row === null ? undefined : toRecord(row)
    },
    list(filter = {}) {
      const where: string[] = []
      const params: Array<string | number> = []
      if (filter.status !== undefined) {
        where.push('status = ?')
        params.push(filter.status)
      }
      if (filter.requester !== undefined) {
        where.push('requester = ?')
        params.push(filter.requester)
      }
      params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500))
      const sql = `SELECT * FROM owner_reviews ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`
      return sqlite
        .query<Row, Array<string | number>>(sql)
        .all(...params)
        .map(toRecord)
    },
    decide(id, status, by, reason) {
      return immediate(sqlite, () => {
        const at = now()
        const result = sqlite
          .query(
            `UPDATE owner_reviews SET status = ?, decided_at = ?, decided_by = ?, reason = COALESCE(?, reason)
             WHERE id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .run(status, at, by, reason ?? null, id, at)
        return result.changes > 0
      })
    },
    setOutcome(id, outcome) {
      sqlite.query('UPDATE owner_reviews SET outcome = ? WHERE id = ?').run(outcome, id)
    },
    expire() {
      return immediate(sqlite, () => {
        const at = now()
        const rows = sqlite
          .query<Row, [number]>(
            "SELECT * FROM owner_reviews WHERE status = 'pending' AND expires_at <= ?",
          )
          .all(at)
        if (rows.length === 0) return []
        sqlite
          .query(
            "UPDATE owner_reviews SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?",
          )
          .run(at, at)
        return rows.map((r) => ({ ...toRecord(r), status: 'expired' as const, decidedAt: at }))
      })
    },
    purge(before) {
      // by the decision (`decided_at`), not the request: a review asked long ago and decided yesterday is kept
      return sqlite
        .query(
          "DELETE FROM owner_reviews WHERE status != 'pending' AND decided_at IS NOT NULL AND decided_at < ?",
        )
        .run(before).changes
    },
  }
}
