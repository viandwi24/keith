import { immediate, type Sqlite } from '../eh/sql.ts'

/** At most this many pairing codes can be active (unused and unexpired) at once. */
export const MAX_ACTIVE_PAIRING_CODES = 3

export type PairingCreateResult = { ok: true; expiresAt: number } | { ok: false; reason: 'limit' }
export type PairingConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' }

/** One-time pairing codes. Only hashes are stored; hashing is the caller's. */
export interface PairingRepo {
  /** Refuses (a value, not a throw) when 3 codes are already active. */
  create(input: { hash: string; createdBy: string; ttlMs: number }): PairingCreateResult
  /** Atomic: succeeds once for an unused, unexpired code. `usedByNode` is recorded when given. */
  consume(hash: string, usedByNode?: string): PairingConsumeResult
  /** Active codes made by this person. */
  active(createdBy: string): number
  /** Delete codes that expired more than `keepMs` ago (default 0: at once); returns how many. */
  purgeExpired(keepMs?: number): number
}

export type CodeProblem = 'unknown' | 'used' | 'expired'

/** Why this code cannot be spent at `at`, or undefined when it can. */
export function codeProblem(sqlite: Sqlite, hash: string, at: number): CodeProblem | undefined {
  const row = sqlite
    .query<{ expires_at: number; used_at: number | null }, [string]>(
      'SELECT expires_at, used_at FROM pairing_codes WHERE hash = ?',
    )
    .get(hash)
  if (row === null) return 'unknown'
  if (row.used_at !== null) return 'used'
  if (row.expires_at <= at) return 'expired'
  return undefined
}

/** Mark a code used (`usedByNode` when given). Call only after `codeProblem` said undefined, inside a transaction. */
export function spendCode(sqlite: Sqlite, hash: string, at: number, usedByNode?: string): void {
  sqlite
    .query('UPDATE pairing_codes SET used_at = ?, used_by_node = ? WHERE hash = ?')
    .run(at, usedByNode ?? null, hash)
}

export function pairingRepo(sqlite: Sqlite, options: { now?: () => number } = {}): PairingRepo {
  const now = options.now ?? Date.now

  return {
    create(input) {
      return immediate(sqlite, () => {
        const at = now()
        const row = sqlite
          .query<{ n: number }, [number]>(
            'SELECT COUNT(*) AS n FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?',
          )
          .get(at)
        if ((row?.n ?? 0) >= MAX_ACTIVE_PAIRING_CODES) return { ok: false, reason: 'limit' }
        const expiresAt = at + input.ttlMs
        sqlite
          .query(
            'INSERT INTO pairing_codes (hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(input.hash, input.createdBy, expiresAt, at)
        return { ok: true, expiresAt }
      })
    },
    consume(hash, usedByNode) {
      return immediate(sqlite, () => {
        const at = now()
        const problem = codeProblem(sqlite, hash, at)
        if (problem !== undefined) return { ok: false, reason: problem }
        spendCode(sqlite, hash, at, usedByNode)
        return { ok: true }
      })
    },
    active(createdBy) {
      const row = sqlite
        .query<{ n: number }, [string, number]>(
          `SELECT COUNT(*) AS n FROM pairing_codes
           WHERE created_by = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(createdBy, now())
      return row?.n ?? 0
    },
    purgeExpired(keepMs = 0) {
      return sqlite.query('DELETE FROM pairing_codes WHERE expires_at <= ?').run(now() - keepMs)
        .changes
    },
  }
}
