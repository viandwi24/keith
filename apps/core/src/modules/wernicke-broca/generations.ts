// The current front generation of each person, in memory (docs/specs/chat-context.md, ADR-0030 §2, P34.2.1). The table
// `front_generations` is the source of truth; this map is a cache of it, read once at boot (before recovery) because the
// session id functions are synchronous. `bump` writes the row first and moves the map only after the write succeeded, so a
// failed write leaves the map as it was.
import type { FrontGenerationsRepo } from '@keith/db'

export interface FrontGenerations {
  /** Reads every stored row into the map. Called once at boot, before `recoverAll`. */
  load(): void
  /** The current generation of a person; 0 when the person never reset (no row). Synchronous. */
  current(personId: string): number
  /**
   * Moves the person to the next generation: the row is written first (one transaction in the repo), then the map. Returns
   * the new generation. A throw from the write propagates and the map keeps its old value.
   */
  bump(personId: string, now: number): number
  /** Drops a person from the map (the purge of a removed person; the row is deleted by the caller). */
  forget(personId: string): void
}

/** The port over the `front_generations` repo. */
export function frontGenerations(repo: FrontGenerationsRepo): FrontGenerations {
  const map = new Map<string, number>()
  return {
    load() {
      map.clear()
      for (const row of repo.list()) map.set(row.personId, row.generation)
    },
    current(personId) {
      return map.get(personId) ?? 0
    },
    bump(personId, now) {
      const next = repo.bump(personId, now)
      map.set(personId, next)
      return next
    },
    forget(personId) {
      map.delete(personId)
    },
  }
}
