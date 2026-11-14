import { immediate, type Sqlite } from '../eh/sql.ts'

export type DeviceRequestStatus = 'pending' | 'approved' | 'denied'

export interface DeviceRequestRecord {
  id: string
  label: string
  ip: string
  status: DeviceRequestStatus
  credentialId: string | null
  createdAt: number
  expiresAt: number
}

/** A request with the hashes the poll and the approval compare against. */
export interface DeviceRequestLookup extends DeviceRequestRecord {
  pollHash: string
  secretHash: string
}

interface Row {
  id: string
  code_hash: string
  poll_hash: string
  label: string
  ip: string
  status: DeviceRequestStatus
  credential_id: string | null
  secret_hash: string
  created_at: number
  expires_at: number
}

const record = (r: Row): DeviceRequestRecord => ({
  id: r.id,
  label: r.label,
  ip: r.ip,
  status: r.status,
  credentialId: r.credential_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

/** At most this many pending requests per client address. */
export const MAX_PENDING_PER_IP = 5

export type DeviceCreateResult = { ok: true } | { ok: false; reason: 'limit' }

/** Device login requests. Only hashes are stored; hashing is the caller's. */
export interface DeviceRequestsRepo {
  /** Refuses (a value, not a throw) when the address already has 5 pending requests. */
  create(input: {
    id: string
    codeHash: string
    pollHash: string
    label: string
    ip: string
    secretHash: string
    ttlMs: number
  }): DeviceCreateResult & { expiresAt?: number }
  get(id: string): DeviceRequestLookup | undefined
  /** The pending, unexpired request with this code hash. */
  findPendingByCode(codeHash: string): DeviceRequestRecord | undefined
  /** Pending, unexpired requests, oldest first. */
  listPending(): DeviceRequestRecord[]
  /** Pending -> approved with the credential to hand over; false when it is no longer pending. */
  approve(id: string, credentialId: string): boolean
  /** Pending -> denied; false when it is no longer pending. */
  deny(id: string): boolean
  /** Forget a request (consumed, or expired). */
  remove(id: string): void
  /**
   * Delete requests expired for more than `graceMs`; returns the credential ids of the approved,
   * never collected ones it removed (the caller revokes them).
   */
  purgeExpired(graceMs: number): { removed: number; credentialIds: string[] }
}

export function deviceRequestsRepo(
  sqlite: Sqlite,
  options: { now?: () => number } = {},
): DeviceRequestsRepo {
  const now = options.now ?? Date.now
  return {
    create(input) {
      return immediate(sqlite, () => {
        const at = now()
        const row = sqlite
          .query<{ n: number }, [string, number]>(
            `SELECT COUNT(*) AS n FROM device_requests
             WHERE ip = ? AND status = 'pending' AND expires_at > ?`,
          )
          .get(input.ip, at)
        if ((row?.n ?? 0) >= MAX_PENDING_PER_IP)
          return { ok: false as const, reason: 'limit' as const }
        const expiresAt = at + input.ttlMs
        sqlite
          .query(
            `INSERT INTO device_requests
             (id, code_hash, poll_hash, label, ip, status, secret_hash, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            input.id,
            input.codeHash,
            input.pollHash,
            input.label,
            input.ip,
            input.secretHash,
            at,
            expiresAt,
          )
        return { ok: true as const, expiresAt }
      })
    },
    get(id) {
      const row = sqlite.query<Row, [string]>('SELECT * FROM device_requests WHERE id = ?').get(id)
      return row === null
        ? undefined
        : { ...record(row), pollHash: row.poll_hash, secretHash: row.secret_hash }
    },
    findPendingByCode(codeHash) {
      const row = sqlite
        .query<Row, [string, number]>(
          `SELECT * FROM device_requests
           WHERE code_hash = ? AND status = 'pending' AND expires_at > ?`,
        )
        .get(codeHash, now())
      return row === null ? undefined : record(row)
    },
    listPending() {
      return sqlite
        .query<Row, [number]>(
          `SELECT * FROM device_requests
           WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id`,
        )
        .all(now())
        .map(record)
    },
    approve(id, credentialId) {
      return (
        sqlite
          .query(
            `UPDATE device_requests SET status = 'approved', credential_id = ?
             WHERE id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .run(credentialId, id, now()).changes > 0
      )
    },
    deny(id) {
      return (
        sqlite
          .query(
            `UPDATE device_requests SET status = 'denied'
             WHERE id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .run(id, now()).changes > 0
      )
    },
    remove(id) {
      sqlite.query('DELETE FROM device_requests WHERE id = ?').run(id)
    },
    purgeExpired(graceMs) {
      return immediate(sqlite, () => {
        const cutoff = now() - graceMs
        const credentialIds = sqlite
          .query<{ credential_id: string }, [number]>(
            'SELECT credential_id FROM device_requests WHERE expires_at <= ? AND credential_id IS NOT NULL',
          )
          .all(cutoff)
          .map((r) => r.credential_id)
        const removed = sqlite
          .query('DELETE FROM device_requests WHERE expires_at <= ?')
          .run(cutoff).changes
        return { removed, credentialIds }
      })
    },
  }
}
