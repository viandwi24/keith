import { AUDIT_LEGACY_SUBJECT_FIELD, AUDIT_SUBJECT_FIELDS } from '@keith/contracts'
import type { Sqlite } from '../eh/sql.ts'

export type AuditVia = 'local' | 'tcp' | 'offline'

export interface AuditEventInput {
  kind: string
  /** A person id, or `system`. */
  actor: string
  via: AuditVia
  /** JSON-able detail; never secrets. */
  detail?: Record<string, unknown>
}

export interface AuditEventRecord extends Required<AuditEventInput> {
  id: number
  at: number
}

/** The rows scanned by one `listFor` call at most (the table is pruned by retention; docs/specs/auth.md, "Audit"). */
export const AUDIT_SCAN_LIMIT = 5000

export interface AuditPage {
  rows: AuditEventRecord[]
  /** Pass as `before` to read on; undefined when the log is read to its start. */
  next: number | undefined
}

/** Append-only security log: rows are never updated; only the retention prune deletes, oldest first. */
export interface AuditRepo {
  add(event: AuditEventInput): void
  /** Newest first. */
  list(limit: number): AuditEventRecord[]
  /**
   * The rows about a person, newest first: the kinds and detail fields named by `AUDIT_SUBJECT_FIELDS` (plus the
   * old `personId` key) are matched by `json_each` (a scalar id or an array of ids); no other row is ever returned. At most `scan` (default
   * `AUDIT_SCAN_LIMIT`) rows older than `before` are looked at per call, so `next` may be set with fewer rows
   * than `limit`: ask again with it.
   */
  listFor(personId: string, options: { limit: number; before?: number; scan?: number }): AuditPage
  /** Deletes the rows older than `before` (epoch ms, `at < before`); returns how many. */
  prune(before: number): number
}

export function auditRepo(sqlite: Sqlite, options: { now?: () => number } = {}): AuditRepo {
  const now = options.now ?? Date.now
  return {
    add(event) {
      sqlite
        .query('INSERT INTO audit_events (at, kind, actor, via, detail) VALUES (?, ?, ?, ?, ?)')
        .run(now(), event.kind, event.actor, event.via, JSON.stringify(event.detail ?? {}))
    },
    prune(before) {
      return sqlite.query('DELETE FROM audit_events WHERE at < ?').run(before).changes
    },
    listFor(personId, options) {
      const scan = options.scan ?? AUDIT_SCAN_LIMIT
      const clauses: string[] = []
      const params: Array<string | number> = [options.before ?? Number.MAX_SAFE_INTEGER, scan]
      for (const [kind, fields] of Object.entries(AUDIT_SUBJECT_FIELDS)) {
        const names = [...new Set([...fields, AUDIT_LEGACY_SUBJECT_FIELD])]
        // json_each yields the one value of a scalar field and every id of an array field (`members`)
        clauses.push(
          `(kind = ? AND (${names
            .map(() => 'EXISTS (SELECT 1 FROM json_each(recent.detail, ?) WHERE value = ?)')
            .join(' OR ')}))`,
        )
        params.push(kind)
        for (const name of names) params.push(`$.${name}`, personId)
      }
      params.push(options.limit)
      const rows = sqlite
        .query<
          { id: number; at: number; kind: string; actor: string; via: AuditVia; detail: string },
          Array<string | number>
        >(
          `WITH recent AS (SELECT * FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?)
           SELECT * FROM recent WHERE ${clauses.join(' OR ')} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params)
        .map((r) => ({
          id: r.id,
          at: r.at,
          kind: r.kind,
          actor: r.actor,
          via: r.via,
          detail: JSON.parse(r.detail) as Record<string, unknown>,
        }))
      const last = rows.at(-1)
      if (rows.length >= options.limit && last !== undefined) return { rows, next: last.id }
      const window = sqlite
        .query<{ n: number; low: number | null }, [number, number]>(
          'SELECT count(*) AS n, min(id) AS low FROM (SELECT id FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?)',
        )
        .get(options.before ?? Number.MAX_SAFE_INTEGER, scan)
      return {
        rows,
        next: window !== null && window.n >= scan && window.low !== null ? window.low : undefined,
      }
    },
    list(limit) {
      return sqlite
        .query<
          { id: number; at: number; kind: string; actor: string; via: AuditVia; detail: string },
          [number]
        >('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((r) => ({
          id: r.id,
          at: r.at,
          kind: r.kind,
          actor: r.actor,
          via: r.via,
          detail: JSON.parse(r.detail) as Record<string, unknown>,
        }))
    },
  }
}
