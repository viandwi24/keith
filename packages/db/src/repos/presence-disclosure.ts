// The `presence_disclosure` table (docs/specs/parietal.md, "Disclosure", ADR-0025 §4): the level a person set for one
// audience. Only the rule in `disclose.ts` reads it; kept while the person exists (removal registry, P27.2.2).
import type { DisclosureLevel } from '@keith/contracts'
import type { Sqlite } from '../eh/sql.ts'

export interface DisclosureEntry {
  audience: string
  level: DisclosureLevel
}

export interface PresenceDisclosureRepo {
  /** The settings a person stored, by audience. Audiences without a row take the defaults of the rule. */
  list(personId: string): DisclosureEntry[]
  /** Sets the level of one audience (insert or replace). */
  set(personId: string, audience: string, level: DisclosureLevel): void
}

export function presenceDisclosureRepo(sqlite: Sqlite): PresenceDisclosureRepo {
  return {
    list(personId) {
      return sqlite
        .query<{ audience: string; level: string }, [string]>(
          'SELECT audience, level FROM presence_disclosure WHERE person_id = ? ORDER BY audience',
        )
        .all(personId)
        .map((r) => ({ audience: r.audience, level: r.level as DisclosureLevel }))
    },
    set(personId, audience, level) {
      sqlite
        .query(
          `INSERT INTO presence_disclosure (person_id, audience, level) VALUES (?, ?, ?)
           ON CONFLICT(person_id, audience) DO UPDATE SET level = excluded.level`,
        )
        .run(personId, audience, level)
    },
  }
}
