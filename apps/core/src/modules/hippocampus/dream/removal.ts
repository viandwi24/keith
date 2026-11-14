// The dreaming share of a removed person (ADR-0031 §8, docs/specs/people.md "Removal", P35.5.6). On removal the `dreams/<personId>/`
// folder (staged plans, preimages) moves into the kept folder, so nothing is left in `dataDir`. The `dream_settings` and
// `dream_runs` rows stay where they are: they have no foreign key to `people`, so the person row's delete does not reach them.
// `purge` (after the keep time) deletes both tables' rows and the folder. `export` writes nothing: the diary is a memory file
// and the memory folder is exported with the rest of the memory.
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DreamingRepo } from '@keith/db'
import type { PersonRemovalHooks } from '../../people/index.ts'
import { outsideDirOf } from './files.ts'

/** The name of the kept folder's copy of `dataDir/dreams/<personId>/`. */
export const KEPT_DREAMS_DIR = 'dreams'

export interface DreamRemovalOptions {
  dataDir: string
  repo: Pick<DreamingRepo, 'deleteForPerson'>
}

export function dreamingRemoval(options: DreamRemovalOptions): PersonRemovalHooks {
  const { dataDir, repo } = options
  return {
    keep(personId, folder) {
      const from = outsideDirOf(dataDir, personId)
      if (!existsSync(from)) return undefined
      const to = join(folder, KEPT_DREAMS_DIR)
      renameSync(from, to)
      return () => {
        renameSync(to, from)
      }
    },

    export() {},

    purge(personId, folder) {
      repo.deleteForPerson(personId)
      rmSync(join(folder, KEPT_DREAMS_DIR), { recursive: true, force: true })
      rmSync(outsideDirOf(dataDir, personId), { recursive: true, force: true })
    },
  }
}
