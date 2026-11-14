import type { Sqlite } from '../eh/sql.ts'

/** Capabilities granted to a person on top of their role (docs/specs/permissions.md). */
export interface GrantsRepo {
  /** The granted capability ids of a person, sorted. */
  list(personId: string): string[]
  /** Grant one; false when the person already had it. */
  add(personId: string, capability: string, by: string, at?: number): boolean
  /** Take one back; false when it was not granted. */
  remove(personId: string, capability: string): boolean
}

export function grantsRepo(sqlite: Sqlite): GrantsRepo {
  return {
    list(personId) {
      return sqlite
        .query<{ capability: string }, [string]>(
          'SELECT capability FROM person_grants WHERE person_id = ? ORDER BY capability',
        )
        .all(personId)
        .map((r) => r.capability)
    },
    add(personId, capability, by, at = Date.now()) {
      return (
        sqlite
          .query(
            `INSERT INTO person_grants (person_id, capability, granted_by, created_at)
             VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(personId, capability, by, at).changes > 0
      )
    },
    remove(personId, capability) {
      return (
        sqlite
          .query('DELETE FROM person_grants WHERE person_id = ? AND capability = ?')
          .run(personId, capability).changes > 0
      )
    },
  }
}
