import type { Sqlite } from '../eh/sql.ts'
import type { Person } from './tokens.ts'

/** How an identifier was written: a user id, a username, an email or a phone alias. */
export type IdentifierKind = 'id' | 'username' | 'email' | 'phone'

/** A person as sign-in needs them: the usual row plus `can_login` (docs/specs/people.md). */
export interface LoginPerson extends Person {
  canLogin: boolean
}

/** The four spellings of one typed identifier; the caller derives them, the repo only queries. */
export interface IdentifierCandidates {
  id: string
  username: string
  email: string
  phone: string
}

export interface IdentifierRecord {
  kind: 'email' | 'phone'
  valueNorm: string
  createdAt: number
}

export interface IdentifiersRepo {
  /**
   * Resolve a typed identifier. Always runs the same four queries, whether or not anything
   * matches, so a known and an unknown identifier cost the same (no enumeration by timing).
   * Order of precedence: id, username, email, phone. Never matches a display name.
   */
  lookup(
    candidates: IdentifierCandidates,
  ): { person: LoginPerson; kind: IdentifierKind } | undefined
  /** False when the normalised value is already taken (by anyone). */
  add(input: {
    personId: string
    kind: 'email' | 'phone'
    valueNorm: string
    createdBy: string | null
    at: number
  }): boolean
  /** Remove one alias; the person it belonged to, or undefined when there was none. */
  remove(valueNorm: string): { personId: string } | undefined
  list(personId: string): IdentifierRecord[]
  /** Whether the person may sign in (`people.can_login`, ADR-0027 §27). Unknown person: false. */
  canLogin(personId: string): boolean
  /** Turn a person's sign-in on or off; true when a row changed. The sessions are the caller's to end. */
  setCanLogin(personId: string, canLogin: boolean): boolean
}

interface PersonRow {
  id: string
  name: string
  role: Person['role']
  username: string | null
  status: Person['status']
  can_login: number
}

const COLUMNS = 'p.id, p.name, p.role, p.username, p.status, p.can_login'
const personOf = (r: PersonRow): LoginPerson => ({
  id: r.id,
  name: r.name,
  role: r.role,
  username: r.username,
  status: r.status,
  canLogin: r.can_login !== 0,
})

export function identifiersRepo(sqlite: Sqlite): IdentifiersRepo {
  const byValue = (value: string, kind: 'email' | 'phone'): PersonRow | null =>
    sqlite
      .query<PersonRow, [string, string]>(
        `SELECT ${COLUMNS} FROM person_identifiers i JOIN people p ON p.id = i.person_id
         WHERE i.value_norm = ? AND i.kind = ?`,
      )
      .get(value, kind)
  return {
    lookup(c) {
      const byId = sqlite
        .query<PersonRow, [string]>(`SELECT ${COLUMNS} FROM people p WHERE p.id = ?`)
        .get(c.id)
      const byName = sqlite
        .query<PersonRow, [string]>(`SELECT ${COLUMNS} FROM people p WHERE p.username = ?`)
        .get(c.username)
      const byEmail = byValue(c.email, 'email')
      const byPhone = byValue(c.phone, 'phone')
      const hit: [PersonRow | null, IdentifierKind][] = [
        [byId, 'id'],
        [byName, 'username'],
        [byEmail, 'email'],
        [byPhone, 'phone'],
      ]
      const found = hit.find(([row]) => row !== null)
      return found === undefined
        ? undefined
        : { person: personOf(found[0] as PersonRow), kind: found[1] }
    },
    add(input) {
      return (
        sqlite
          .query(
            `INSERT INTO person_identifiers (person_id, kind, value_norm, created_by, created_at)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (value_norm) DO NOTHING`,
          )
          .run(input.personId, input.kind, input.valueNorm, input.createdBy, input.at).changes > 0
      )
    },
    remove(valueNorm) {
      const row = sqlite
        .query<{ person_id: string }, [string]>(
          'SELECT person_id FROM person_identifiers WHERE value_norm = ?',
        )
        .get(valueNorm)
      if (row === null) return undefined
      sqlite.query('DELETE FROM person_identifiers WHERE value_norm = ?').run(valueNorm)
      return { personId: row.person_id }
    },
    list(personId) {
      return sqlite
        .query<{ kind: 'email' | 'phone'; value_norm: string; created_at: number }, [string]>(
          'SELECT kind, value_norm, created_at FROM person_identifiers WHERE person_id = ? ORDER BY created_at, value_norm',
        )
        .all(personId)
        .map((r) => ({ kind: r.kind, valueNorm: r.value_norm, createdAt: r.created_at }))
    },
    canLogin(personId) {
      const row = sqlite
        .query<{ can_login: number }, [string]>('SELECT can_login FROM people WHERE id = ?')
        .get(personId)
      return row !== null && row.can_login !== 0
    },
    setCanLogin(personId, canLogin) {
      return (
        sqlite
          .query('UPDATE people SET can_login = ? WHERE id = ? AND can_login != ?')
          .run(canLogin ? 1 : 0, personId, canLogin ? 1 : 0).changes > 0
      )
    },
  }
}
