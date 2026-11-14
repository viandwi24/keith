// The `presence_status` table (docs/specs/parietal.md, "Computation"): the manual busy status of a person, the first
// overlay source. One row per person; `/free` deletes it; an expired row is pruned by retention.ts.
import type { Sqlite } from '../eh/sql.ts'

export interface StatusRow {
  personId: string
  note: string | null
  /** Epoch ms the status ends, or null for no end. */
  until: number | null
  /** Epoch ms the status was set. */
  setAt: number
}

export interface PresenceStatusRepo {
  get(personId: string): StatusRow | undefined
  /** Sets busy for a person, replacing an earlier status. */
  set(personId: string, status: { note: string | null; until: number | null; setAt: number }): void
  /** Deletes the status of a person; false when none. */
  clear(personId: string): boolean
}

interface Row {
  person_id: string
  note: string | null
  until: number | null
  set_at: number
}

export function presenceStatusRepo(sqlite: Sqlite): PresenceStatusRepo {
  return {
    get(personId) {
      const row = sqlite
        .query<Row, [string]>('SELECT * FROM presence_status WHERE person_id = ?')
        .get(personId)
      return row === null
        ? undefined
        : { personId: row.person_id, note: row.note, until: row.until, setAt: row.set_at }
    },
    set(personId, status) {
      sqlite
        .query(
          `INSERT INTO presence_status (person_id, state, note, until, set_at) VALUES (?, 'busy', ?, ?, ?)
           ON CONFLICT(person_id) DO UPDATE SET state = 'busy', note = excluded.note,
             until = excluded.until, set_at = excluded.set_at`,
        )
        .run(personId, status.note, status.until, status.setAt)
    },
    clear(personId) {
      return (
        sqlite.query('DELETE FROM presence_status WHERE person_id = ?').run(personId).changes > 0
      )
    },
  }
}
