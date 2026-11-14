// The wernicke-broca share of a removed person (ADR-0030 §11, docs/specs/chat-context.md "Removal", P34.2.4). The
// generation rows of `front_generations` are kept with the person (`keep` moves nothing: the row has no foreign key and
// the person row is deleted right after the keep runs). `purge` deletes the row and drops the person from the map. The
// conversations of every generation are in the conversations part (`people/removed.ts`): its `front:<id>` prefix covers
// `front:<id>:g<n>`, so `conversation.jsonl` holds every generation with no change here.
import type { FrontGenerationsRepo } from '@keith/db'
import type { PersonRemovalHooks } from '../people/index.ts'
import type { FrontGenerations } from './generations.ts'

export interface WernickeBrocaRemovalOptions {
  /** The table of the current generation of each person. */
  generations: Pick<FrontGenerationsRepo, 'delete'>
  /** The map of the same generations, read at boot (dropped with the row). */
  map: Pick<FrontGenerations, 'forget'>
}

export function wernickeBrocaRemoval(options: WernickeBrocaRemovalOptions): PersonRemovalHooks {
  return {
    keep() {
      return undefined
    },
    export() {},
    purge(personId) {
      options.generations.delete(personId)
      options.map.forget(personId)
    },
  }
}
