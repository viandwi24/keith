// The `presence_status` table (docs/specs/parietal.md, "Computation"): the stated status of a person, `busy` (the first
// overlay source) or `out` (ADR-0034 §5), with a start. One row per person; `/free` deletes it; an expired row is pruned
// by retention.ts.
import type { Sqlite } from '../eh/sql.ts'

/** The kinds of a stated status: `busy` (do not disturb) and `out` (away from the desk, reachable elsewhere). */
export type StatusKind = 'busy' | 'out'

export interface StatusRow {
  personId: string
  kind: StatusKind
  note: string | null
  /** Epoch ms the status starts; null means it started when it was set. */
  from: number | null
  /** Epoch ms the status ends, or null for no end. */
  until: number | null
  /** Epoch ms the status was set. */
  setAt: number
}

export interface PresenceStatusRepo {
  get(personId: string): StatusRow | undefined
  /** Sets a status for a person, replacing an earlier one. `kind` defaults to `busy`, `from` to null (now). */
  set(
    personId: string,
    status: {
      kind?: StatusKind
      note: string | null
      from?: number | null
      until: number | null
      setAt: number
    },
  ): void
  /** Deletes the status of a person; false when none. */
  clear(personId: string): boolean
}

interface Row {
  person_id: string
  state: string
  from: number | null
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
        : {
            personId: row.person_id,
            kind: row.state === 'out' ? 'out' : 'busy',
            note: row.note,
            from: row.from,
            until: row.until,
            setAt: row.set_at,
          }
    },
    set(personId, status) {
      sqlite
        .query(
          `INSERT INTO presence_status (person_id, state, note, "from", until, set_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(person_id) DO UPDATE SET state = excluded.state, note = excluded.note,
             "from" = excluded."from", until = excluded.until, set_at = excluded.set_at`,
        )
        .run(
          personId,
          status.kind ?? 'busy',
          status.note,
          status.from ?? null,
          status.until,
          status.setAt,
        )
    },
    clear(personId) {
      return (
        sqlite.query('DELETE FROM presence_status WHERE person_id = ?').run(personId).changes > 0
      )
    },
  }
}
