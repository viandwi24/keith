import type { PersonRole } from '../eh/person-rows.ts'
import { immediate, type Sqlite } from '../eh/sql.ts'

export type PersonStatus = 'active' | 'suspended'

/** The person a credential belongs to, as authentication needs them. */
export interface Person {
  id: string
  name: string
  role: PersonRole
  username: string | null
  status: PersonStatus
}

export interface TokenRecord {
  id: string
  personId: string
  label: string
}

/** A token row as `list` shows it (never the hash). */
export interface TokenRow extends TokenRecord {
  createdAt: number
  revokedAt: number | null
}

/** People and their client tokens. Only token hashes are stored; hashing is the caller's. */
export interface TokensRepo {
  owner(): Person | undefined
  /** Insert the owner (username `owner`); the person is a plain `{ id, name, role }`. */
  createOwner(person: { id: string; name: string; role: PersonRole }): void
  /** Change the display name of a person. */
  setName(personId: string, name: string): void
  addToken(token: TokenRecord & { hash: string }): void
  /** The live (not revoked) token with this hash. */
  findByHash(hash: string): (TokenRecord & { person: Person }) | undefined
  /** Revoke every live token of a person; returns how many. */
  revokeAll(personId: string): number
  /** Every token of a person, newest first (live and revoked). */
  list(personId: string): TokenRow[]
  /** Revoke one live token by id; false when there is none. */
  revoke(id: string): boolean
}

export function tokensRepo(sqlite: Sqlite): TokensRepo {
  return {
    owner() {
      return (
        sqlite
          .query<Person, []>(
            "SELECT id, name, role, username, status FROM people WHERE role = 'owner' LIMIT 1",
          )
          .get() ?? undefined
      )
    },
    createOwner(person) {
      sqlite
        .query(
          'INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          person.id,
          person.name,
          person.role,
          Date.now(),
          person.role === 'owner' ? 'owner' : null,
          Date.now(),
        )
    },
    setName(personId, name) {
      sqlite
        .query('UPDATE people SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, Date.now(), personId)
    },
    list(personId) {
      return sqlite
        .query<
          {
            id: string
            person_id: string
            label: string
            created_at: number
            revoked_at: number | null
          },
          [string]
        >(
          'SELECT id, person_id, label, created_at, revoked_at FROM client_tokens WHERE person_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(personId)
        .map((r) => ({
          id: r.id,
          personId: r.person_id,
          label: r.label,
          createdAt: r.created_at,
          revokedAt: r.revoked_at,
        }))
    },
    revoke(id) {
      return (
        sqlite
          .query('UPDATE client_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(Date.now(), id).changes > 0
      )
    },
    addToken(token) {
      sqlite
        .query(
          'INSERT INTO client_tokens (id, person_id, hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(token.id, token.personId, token.hash, token.label, Date.now())
    },
    findByHash(hash) {
      const row = sqlite
        .query<
          {
            id: string
            person_id: string
            label: string
            name: string
            role: Person['role']
            username: string | null
            status: Person['status']
          },
          [string]
        >(
          `SELECT t.id, t.person_id, t.label, p.name, p.role, p.username, p.status FROM client_tokens t
           JOIN people p ON p.id = t.person_id WHERE t.hash = ? AND t.revoked_at IS NULL`,
        )
        .get(hash)
      if (row === null) return undefined
      return {
        id: row.id,
        personId: row.person_id,
        label: row.label,
        person: {
          id: row.person_id,
          name: row.name,
          role: row.role,
          username: row.username,
          status: row.status,
        },
      }
    },
    revokeAll(personId) {
      return immediate(sqlite, () => {
        const result = sqlite
          .query(
            'UPDATE client_tokens SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL',
          )
          .run(Date.now(), personId)
        return result.changes
      })
    },
  }
}
