import { immediate, type Sqlite } from '../eh/sql.ts'
import type { Person } from './tokens.ts'

export type CredentialKind = 'device' | 'token'

export interface CredentialRecord {
  id: string
  personId: string
  kind: CredentialKind
  label: string
  createdAt: number
  lastSeenAt: number | null
  lastIp: string | null
  revokedAt: number | null
  /** End of the step-up window (ms), or null when never stepped up. */
  elevatedUntil: number | null
  /** The methods that made the session; an older row (no value stored) reads as `['legacy']`. */
  methods: string[]
  /** 0 possession (device code, token), 1 PIN, 2 password. Older rows are 0. */
  assurance: 0 | 1 | 2
  /** The session ends when it has been idle until here (ms); null = no limit (grandfathered). */
  idleExpiresAt: number | null
  /** The session ends here whatever its use (ms); null = no limit. */
  absoluteExpiresAt: number | null
  userAgent: string | null
  /** Why it ended: `logout`, `admin`, `rotated`, `evicted`, ... */
  revokedReason: string | null
}

/** A credential row with the hash of its secret and its person (for verification). */
export interface CredentialLookup extends CredentialRecord {
  secretHash: string
  person: Person
}

interface Row {
  id: string
  person_id: string
  kind: CredentialKind
  label: string
  secret_hash: string
  created_at: number
  last_seen_at: number | null
  last_ip: string | null
  revoked_at: number | null
  elevated_until: number | null
  methods: string | null
  assurance: 0 | 1 | 2
  idle_expires_at: number | null
  absolute_expires_at: number | null
  user_agent: string | null
  revoked_reason: string | null
}

const methodsOf = (raw: string | null): string[] => {
  if (raw === null) return ['legacy']
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === 'string')
      : ['legacy']
  } catch {
    return ['legacy']
  }
}

const record = (r: Row): CredentialRecord => ({
  id: r.id,
  personId: r.person_id,
  kind: r.kind,
  label: r.label,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  lastIp: r.last_ip,
  revokedAt: r.revoked_at,
  elevatedUntil: r.elevated_until,
  methods: methodsOf(r.methods),
  assurance: r.assurance,
  idleExpiresAt: r.idle_expires_at,
  absoluteExpiresAt: r.absolute_expires_at,
  userAgent: r.user_agent,
  revokedReason: r.revoked_reason,
})

/** Session credentials (`device` and `token`). Only the hash of the secret is stored. */
export interface CredentialsRepo {
  create(input: {
    id: string
    personId: string
    kind: CredentialKind
    label: string
    secretHash: string
    /** Default `[kind]`. */
    methods?: string[]
    assurance?: 0 | 1 | 2
    /** Lifetimes from now in ms; 0 or absent = no limit. */
    idleMs?: number
    absoluteMs?: number
    userAgent?: string | undefined
  }): void
  /** The credential (live or revoked) with its person, or undefined. */
  find(id: string): CredentialLookup | undefined
  /**
   * Record that the credential was used. A session with an idle limit slides it: the idle window
   * (`idle_expires_at` minus the last use, or the creation) is kept and restarts at `at`.
   */
  touch(id: string, ip: string | undefined, at: number): void
  /** Credentials of a person, newest first (live and revoked); optionally one kind. */
  list(personId: string, kind?: CredentialKind): CredentialRecord[]
  /** Revoke one live credential (optionally only of this kind); false when there is none. */
  revoke(id: string, kind?: CredentialKind, reason?: string): boolean
  /** The live sessions of a person at `at`: not revoked, not rotated away, not expired; newest first. */
  sessions(personId: string, at: number): CredentialRecord[]
  /**
   * Replace a live credential by a new one (same person, kind, label, methods and expiries; the
   * given assurance and step-up window). The old one keeps working for `graceMs` so a request in
   * flight is not cut off, then ends (`revoked_reason = 'rotated'`). False when the old one is gone.
   */
  rotate(
    oldId: string,
    next: {
      id: string
      secretHash: string
      assurance: 0 | 1 | 2
      methods: string[]
      elevatedUntil: number | null
    },
    graceMs: number,
  ): boolean
  /**
   * Keep at most `max` live sign-in sessions (a `device` credential made by the password or a PIN)
   * of a person: revoke the longest idle ones beyond it (`revoked_reason = 'evicted'`). Device-code
   * approvals, tokens and rows from before sessions (no `methods`) are never evicted. Returns how many.
   */
  evict(personId: string, max: number): number
  /** Revoke every live credential of a person that a method made (e.g. `pin`); returns how many. */
  revokeMethod(personId: string, method: string, reason?: string): number
  /** Set the step-up window end of a live credential; false when it is gone or revoked. */
  setElevated(id: string, until: number): boolean
  /** Revoke every live credential of a person; returns how many. */
  revokeAll(personId: string, reason?: string): number
}

export function credentialsRepo(
  sqlite: Sqlite,
  options: { now?: () => number } = {},
): CredentialsRepo {
  const now = options.now ?? Date.now
  return {
    create(input) {
      const at = now()
      sqlite
        .query(
          `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at, methods,
             assurance, idle_expires_at, absolute_expires_at, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.kind,
          input.label,
          input.secretHash,
          at,
          JSON.stringify(input.methods ?? [input.kind]),
          input.assurance ?? 0,
          (input.idleMs ?? 0) > 0 ? at + (input.idleMs as number) : null,
          (input.absoluteMs ?? 0) > 0 ? at + (input.absoluteMs as number) : null,
          input.userAgent ?? null,
        )
    },
    find(id) {
      const row = sqlite
        .query<
          Row & {
            name: string
            role: Person['role']
            username: string | null
            status: Person['status']
          },
          [string]
        >(
          `SELECT c.*, p.name, p.role, p.username, p.status FROM credentials c
           JOIN people p ON p.id = c.person_id WHERE c.id = ?`,
        )
        .get(id)
      if (row === null) return undefined
      return {
        ...record(row),
        secretHash: row.secret_hash,
        person: {
          id: row.person_id,
          name: row.name,
          role: row.role,
          username: row.username,
          status: row.status,
        },
      }
    },
    touch(id, ip, at) {
      // keep the idle window: the new end is `at` plus (old end - last use or creation)
      sqlite
        .query(
          `UPDATE credentials SET last_seen_at = ?, last_ip = ?,
             idle_expires_at = CASE WHEN idle_expires_at IS NULL THEN NULL
               ELSE ? + (idle_expires_at - coalesce(last_seen_at, created_at)) END
           WHERE id = ?`,
        )
        .run(at, ip ?? null, at, id)
    },
    list(personId, kind) {
      const rows =
        kind === undefined
          ? sqlite
              .query<Row, [string]>(
                'SELECT * FROM credentials WHERE person_id = ? ORDER BY created_at DESC, id DESC',
              )
              .all(personId)
          : sqlite
              .query<Row, [string, string]>(
                'SELECT * FROM credentials WHERE person_id = ? AND kind = ? ORDER BY created_at DESC, id DESC',
              )
              .all(personId, kind)
      return rows.map(record)
    },
    revoke(id, kind, reason) {
      const at = now()
      const result =
        kind === undefined
          ? sqlite
              .query(
                'UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
              )
              .run(at, reason ?? null, id)
          : sqlite
              .query(
                'UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND kind = ? AND revoked_at IS NULL',
              )
              .run(at, reason ?? null, id, kind)
      return result.changes > 0
    },
    sessions(personId, at) {
      return sqlite
        .query<Row, [string, number, number]>(
          `SELECT * FROM credentials WHERE person_id = ? AND revoked_at IS NULL AND revoked_reason IS NULL
             AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
             AND (idle_expires_at IS NULL OR idle_expires_at > ?)
           ORDER BY created_at DESC, id DESC`,
        )
        .all(personId, at, at)
        .map(record)
    },
    rotate(oldId, next, graceMs) {
      return immediate(sqlite, () => {
        const at = now()
        const old = sqlite
          .query<Row, [string]>('SELECT * FROM credentials WHERE id = ? AND revoked_at IS NULL')
          .get(oldId)
        if (old === null) return false
        sqlite
          .query(
            `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at, last_seen_at,
               last_ip, elevated_until, methods, assurance, idle_expires_at, absolute_expires_at, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            next.id,
            old.person_id,
            old.kind,
            old.label,
            next.secretHash,
            at,
            at,
            old.last_ip,
            next.elevatedUntil,
            JSON.stringify(next.methods),
            next.assurance,
            old.idle_expires_at === null
              ? null
              : at + (old.idle_expires_at - (old.last_seen_at ?? old.created_at)),
            old.absolute_expires_at,
            old.user_agent,
          )
        // the old secret ends after a short grace, and no longer counts as a session
        sqlite
          .query(
            `UPDATE credentials SET revoked_reason = 'rotated',
               absolute_expires_at = min(coalesce(absolute_expires_at, ?), ?) WHERE id = ?`,
          )
          .run(at + graceMs, at + graceMs, oldId)
        return true
      })
    },
    evict(personId, max) {
      return immediate(sqlite, () => {
        const at = now()
        const live = sqlite
          .query<{ id: string }, [string, number, number]>(
            `SELECT id FROM credentials WHERE person_id = ? AND kind = 'device' AND revoked_at IS NULL
               AND revoked_reason IS NULL AND methods IS NOT NULL
               AND (methods LIKE '%"password"%' OR methods LIKE '%"pin"%')
               AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
               AND (idle_expires_at IS NULL OR idle_expires_at > ?)
             ORDER BY coalesce(last_seen_at, created_at) DESC, id`,
          )
          .all(personId, at, at)
        for (const row of live.slice(max)) {
          sqlite
            .query("UPDATE credentials SET revoked_at = ?, revoked_reason = 'evicted' WHERE id = ?")
            .run(at, row.id)
        }
        return Math.max(0, live.length - max)
      })
    },
    setElevated(id, until) {
      return (
        sqlite
          .query('UPDATE credentials SET elevated_until = ? WHERE id = ? AND revoked_at IS NULL')
          .run(until, id).changes > 0
      )
    },
    revokeMethod(personId, method, reason) {
      return sqlite
        .query(
          `UPDATE credentials SET revoked_at = ?, revoked_reason = ?
           WHERE person_id = ? AND revoked_at IS NULL AND methods LIKE ?`,
        )
        .run(now(), reason ?? null, personId, `%"${method.replace(/[%_"\\]/g, '')}"%`).changes
    },
    revokeAll(personId, reason) {
      return immediate(
        sqlite,
        () =>
          sqlite
            .query(
              'UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE person_id = ? AND revoked_at IS NULL',
            )
            .run(now(), reason ?? null, personId).changes,
      )
    },
  }
}
