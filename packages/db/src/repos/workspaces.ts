// The `workspaces` table (docs/specs/workspace.md, "Data"): one row per person holding the workspace document as JSON. A write
// names the version it replaces; when the row moved on meanwhile nothing is written (compare and set).
import type { Sqlite } from '../eh/sql.ts'

export interface WorkspaceRow {
  personId: string
  version: number
  /** The document as JSON; the core parses and validates it. */
  doc: string
  updatedAt: number
}

export interface WorkspacesRepo {
  /** The stored row of a person, or undefined (the empty workspace, version 0). */
  get(personId: string): WorkspaceRow | undefined
  /**
   * Writes `doc` at `version` when the stored version is still `baseVersion` (no row counts as version 0). False when another
   * write came first; nothing is then written.
   */
  put(personId: string, baseVersion: number, version: number, doc: string, at: number): boolean
  /** Deletes the row of a person (a removed person). True when a row was deleted. */
  delete(personId: string): boolean
}

interface Row {
  person_id: string
  version: number
  doc: string
  updated_at: number
}

export function workspacesRepo(sqlite: Sqlite): WorkspacesRepo {
  return {
    get(personId) {
      const row = sqlite
        .query<Row, [string]>('SELECT * FROM workspaces WHERE person_id = ?')
        .get(personId)
      return row === null
        ? undefined
        : { personId: row.person_id, version: row.version, doc: row.doc, updatedAt: row.updated_at }
    },
    put(personId, baseVersion, version, doc, at) {
      if (baseVersion === 0) {
        const inserted = sqlite
          .query(
            'INSERT INTO workspaces (person_id, version, doc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(person_id) DO NOTHING',
          )
          .run(personId, version, doc, at)
        if (inserted.changes > 0) return true
      }
      return (
        sqlite
          .query(
            'UPDATE workspaces SET version = ?, doc = ?, updated_at = ? WHERE person_id = ? AND version = ?',
          )
          .run(version, doc, at, personId, baseVersion).changes > 0
      )
    },
    delete(personId) {
      return sqlite.query('DELETE FROM workspaces WHERE person_id = ?').run(personId).changes > 0
    },
  }
}
