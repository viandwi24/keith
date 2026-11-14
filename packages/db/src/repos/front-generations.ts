// The current front generation of each person (docs/specs/chat-context.md, ADR-0030 §2, P34.2.1). A reset bumps one row in
// one `BEGIN IMMEDIATE`: the generation is read and written inside the same transaction, so two resets cannot take the same
// number. A missing row means generation 0; the first bump creates the row with generation 1.
import { immediate, type Sqlite } from '../eh/sql.ts'

/** One person's current generation. */
export interface FrontGenerationRecord {
  personId: string
  generation: number
  updatedAt: number
}

export interface FrontGenerationsRepo {
  /** The stored row of a person, or undefined when the person never reset (generation 0). */
  get(personId: string): FrontGenerationRecord | undefined
  /**
   * Moves the person to the next generation (the current one plus 1, 0 when no row exists) and stores `at` as its time, in one
   * transaction. Returns the generation written.
   */
  bump(personId: string, at: number): number
  /** Every stored row, ordered by person id. */
  list(): FrontGenerationRecord[]
  /** Deletes the row of a person (the purge of a removed person, ADR-0030 §11). True when a row was deleted. */
  delete(personId: string): boolean
}

interface Row {
  person_id: string
  generation: number
  updated_at: number
}

const toRecord = (row: Row): FrontGenerationRecord => ({
  personId: row.person_id,
  generation: row.generation,
  updatedAt: row.updated_at,
})

export function frontGenerationsRepo(sqlite: Sqlite): FrontGenerationsRepo {
  return {
    get(personId) {
      const row = sqlite
        .query<Row, [string]>(
          'SELECT person_id, generation, updated_at FROM front_generations WHERE person_id = ?',
        )
        .get(personId)
      return row === null ? undefined : toRecord(row)
    },
    bump(personId, at) {
      return immediate(sqlite, () => {
        const current =
          sqlite
            .query<{ generation: number }, [string]>(
              'SELECT generation FROM front_generations WHERE person_id = ?',
            )
            .get(personId)?.generation ?? 0
        const next = current + 1
        sqlite
          .query(
            `INSERT INTO front_generations (person_id, generation, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (person_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`,
          )
          .run(personId, next, at)
        return next
      })
    },
    delete(personId) {
      return (
        sqlite.query('DELETE FROM front_generations WHERE person_id = ?').run(personId).changes > 0
      )
    },
    list() {
      return sqlite
        .query<Row, []>(
          'SELECT person_id, generation, updated_at FROM front_generations ORDER BY person_id',
        )
        .all()
        .map(toRecord)
    },
  }
}
