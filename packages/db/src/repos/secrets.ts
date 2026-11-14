import type { Sqlite } from '../eh/sql.ts'
import type { LoginPerson } from './identifiers.ts'

/** Human secrets of a person: a password (starts a session) and a PIN (step-up only). */
export type SecretKind = 'password' | 'pin'

/** Counter row of failed attempts for one (subject, ip). `ip` is `*` for the person-wide counter. */
export interface AttemptRecord {
  failures: number
  lastFailureAt: number
  lockedAt: number | null
}

/** The ip value of the person-wide counter (it sums failures from every address). */
export const ANY_IP = '*'

/**
 * Password and PIN hashes (argon2id PHC strings, hashed by the caller) and the failed-attempt
 * counters behind throttling. docs/specs/auth.md, docs/specs/db.md.
 */
export interface SecretsRepo {
  /** The person with this exact (lower-case) username, as authentication needs them. */
  findPerson(username: string): LoginPerson | undefined
  get(personId: string, kind: SecretKind): { hash: string; updatedAt: number } | undefined
  /** Kinds that are set, never the hashes. */
  kinds(personId: string): SecretKind[]
  set(personId: string, kind: SecretKind, hash: string, at: number): void
  /** Remove one secret; false when it was not set. */
  clear(personId: string, kind: SecretKind): boolean
  attempt(subject: string, ip: string): AttemptRecord | undefined
  /** Count one failure (atomic upsert) and return the new counter. */
  fail(subject: string, ip: string, at: number): AttemptRecord
  /** Mark the person-wide counter of a subject locked. */
  lock(subject: string, at: number): void
  /** Forget every counter of a subject (a success); returns whether it was locked. */
  reset(subject: string): boolean
  /** Whether the subject is locked right now. */
  locked(subject: string): boolean
  /** Drop counters that are not locked and whose last failure is older than `before`. */
  prune(before: number): number
}

interface AttemptRow {
  failures: number
  last_failure_at: number
  locked_at: number | null
}

const attemptOf = (r: AttemptRow): AttemptRecord => ({
  failures: r.failures,
  lastFailureAt: r.last_failure_at,
  lockedAt: r.locked_at,
})

export function secretsRepo(sqlite: Sqlite): SecretsRepo {
  const row = (subject: string, ip: string): AttemptRow | null =>
    sqlite
      .query<AttemptRow, [string, string]>(
        'SELECT failures, last_failure_at, locked_at FROM auth_attempts WHERE subject = ? AND ip = ?',
      )
      .get(subject, ip)
  return {
    findPerson(username) {
      const found = sqlite
        .query<Omit<LoginPerson, 'canLogin'> & { can_login: number }, [string]>(
          'SELECT id, name, role, username, status, can_login FROM people WHERE username = ?',
        )
        .get(username)
      if (found === null) return undefined
      const { can_login, ...person } = found
      return { ...person, canLogin: can_login !== 0 }
    },
    get(personId, kind) {
      const found = sqlite
        .query<{ hash: string; updated_at: number }, [string, string]>(
          'SELECT hash, updated_at FROM person_secrets WHERE person_id = ? AND kind = ?',
        )
        .get(personId, kind)
      return found === null ? undefined : { hash: found.hash, updatedAt: found.updated_at }
    },
    kinds(personId) {
      return sqlite
        .query<{ kind: SecretKind }, [string]>(
          'SELECT kind FROM person_secrets WHERE person_id = ? ORDER BY kind',
        )
        .all(personId)
        .map((r) => r.kind)
    },
    set(personId, kind, hash, at) {
      sqlite
        .query(
          `INSERT INTO person_secrets (person_id, kind, hash, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (person_id, kind) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
        )
        .run(personId, kind, hash, at)
    },
    clear(personId, kind) {
      return (
        sqlite
          .query('DELETE FROM person_secrets WHERE person_id = ? AND kind = ?')
          .run(personId, kind).changes > 0
      )
    },
    attempt(subject, ip) {
      const found = row(subject, ip)
      return found === null ? undefined : attemptOf(found)
    },
    fail(subject, ip, at) {
      sqlite
        .query(
          `INSERT INTO auth_attempts (subject, ip, failures, last_failure_at) VALUES (?, ?, 1, ?)
           ON CONFLICT (subject, ip) DO UPDATE SET failures = failures + 1, last_failure_at = excluded.last_failure_at`,
        )
        .run(subject, ip, at)
      return attemptOf(row(subject, ip) as AttemptRow)
    },
    lock(subject, at) {
      sqlite
        .query(
          `INSERT INTO auth_attempts (subject, ip, failures, last_failure_at, locked_at) VALUES (?, ?, 0, ?, ?)
           ON CONFLICT (subject, ip) DO UPDATE SET locked_at = coalesce(locked_at, excluded.locked_at)`,
        )
        .run(subject, ANY_IP, at, at)
    },
    reset(subject) {
      const wasLocked = this.locked(subject)
      sqlite.query('DELETE FROM auth_attempts WHERE subject = ?').run(subject)
      return wasLocked
    },
    locked(subject) {
      return row(subject, ANY_IP)?.locked_at != null
    },
    prune(before) {
      return sqlite
        .query('DELETE FROM auth_attempts WHERE locked_at IS NULL AND last_failure_at < ?')
        .run(before).changes
    },
  }
}
