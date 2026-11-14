// The per-person style of Keith's replies (docs/specs/prefrontal.md, "Per-person style and its guard", ADR-0029 §3, P33.2.2).
// One row per person who set something; an absent row means every default (`DEFAULT_PERSON_STYLE`). A patch is merged over
// the stored style in one `BEGIN IMMEDIATE`, so two patches cannot drop each other's fields. The deny list and the owner's
// audited read are the service's job (P33.2.4); this repo checks the shapes of the contract and the foreign key.
import {
  DEFAULT_PERSON_STYLE,
  type PersonStyle,
  type PersonStylePatch,
  PersonStylePatchSchema,
  PersonStyleSchema,
} from '@keith/contracts'
import { immediate, type Sqlite } from '../eh/sql.ts'

/** A stored style with who wrote it and when. */
export interface PersonStyleRecord {
  personId: string
  style: PersonStyle
  updatedAt: number
  updatedBy: string
}

export interface PersonStyleRepoOptions {
  now?: () => number
}

export interface PersonStyleRepo {
  /** The stored style of a person, or undefined when no row exists (the caller applies the defaults). */
  get(personId: string): PersonStyleRecord | undefined
  /**
   * Merges `patch` over the stored style (or the defaults) and stores the result, in one transaction. `address: null`
   * clears the address. Returns the full style after the write. A patch that breaks a shape or names an unknown person
   * throws and writes nothing.
   */
  upsert(personId: string, patch: PersonStylePatch, updatedBy: string): PersonStyleRecord
  /** Deletes the row of a person (the removal registry's purge). True when a row was deleted. */
  delete(personId: string): boolean
}

interface StyleRow {
  person_id: string
  address: string | null
  language: string
  brevity: string
  formality: string
  gentle_topics: string
  updated_at: number
  updated_by: string
}

const toRecord = (row: StyleRow): PersonStyleRecord => ({
  personId: row.person_id,
  style: PersonStyleSchema.parse({
    address: row.address,
    language: row.language,
    brevity: row.brevity,
    formality: row.formality,
    gentleTopics: JSON.parse(row.gentle_topics),
  }),
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
})

export function personStyleRepo(
  sqlite: Sqlite,
  options: PersonStyleRepoOptions = {},
): PersonStyleRepo {
  const now = options.now ?? Date.now

  const read = (personId: string): PersonStyleRecord | undefined => {
    const row = sqlite
      .query<StyleRow, [string]>(
        `SELECT person_id, address, language, brevity, formality, gentle_topics, updated_at, updated_by
         FROM person_style WHERE person_id = ?`,
      )
      .get(personId)
    return row === null ? undefined : toRecord(row)
  }

  return {
    get: read,
    upsert(personId, patch, updatedBy) {
      const checked = PersonStylePatchSchema.parse(patch)
      return immediate(sqlite, () => {
        const current = read(personId)?.style ?? DEFAULT_PERSON_STYLE
        const defined = Object.fromEntries(
          Object.entries(checked).filter(([, value]) => value !== undefined),
        )
        const style = PersonStyleSchema.parse({ ...current, ...defined })
        sqlite
          .query(
            `INSERT INTO person_style (person_id, address, language, brevity, formality, gentle_topics, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (person_id) DO UPDATE SET address = excluded.address, language = excluded.language,
               brevity = excluded.brevity, formality = excluded.formality, gentle_topics = excluded.gentle_topics,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          )
          .run(
            personId,
            style.address,
            style.language,
            style.brevity,
            style.formality,
            JSON.stringify(style.gentleTopics),
            now(),
            updatedBy,
          )
        return read(personId) as PersonStyleRecord
      })
    },
    delete(personId) {
      return sqlite.query('DELETE FROM person_style WHERE person_id = ?').run(personId).changes > 0
    },
  }
}
