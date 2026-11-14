// A removed person's presence (ADR-0027 §26, docs/specs/people.md "Removal"): `keep` writes the person's clients,
// signals, manual status and disclosure settings into the kept folder (the live rows stay until the keep time),
// `export` writes the same file for `people export`, and `purge` deletes the live rows once the keep time has passed.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sqlite } from '@keith/db'
import { type PersonRemovalHooks, removedFolderOf } from '../people/index.ts'

/** The presence tables of a person, in the order they are written and deleted. */
const TABLES = ['clients', 'presence_signals', 'presence_status', 'presence_disclosure'] as const

export const PRESENCE_FILE = 'presence.json'

export interface ParietalRemovalOptions {
  sqlite: Sqlite
  dataDir: string
}

export function parietalRemoval(options: ParietalRemovalOptions): PersonRemovalHooks {
  const { sqlite, dataDir } = options
  /** The person's rows of every presence table, as the export file holds them. */
  const dump = (personId: string): Record<string, unknown[]> => {
    const out: Record<string, unknown[]> = {}
    for (const table of TABLES)
      out[table] = sqlite.query(`SELECT * FROM ${table} WHERE person_id = ?`).all(personId)
    return out
  }
  return {
    keep(personId, folder) {
      writeFileSync(
        join(folder, PRESENCE_FILE),
        `${JSON.stringify({ personId, ...dump(personId) }, null, 2)}\n`,
        { mode: 0o600 },
      )
      return undefined
    },
    export(personId, dest) {
      const folder = removedFolderOf(dataDir, personId)
      const target = join(dest, PRESENCE_FILE)
      // a removed person: the kept copy is the record; a live person: the rows as they are now
      if (existsSync(join(folder, 'manifest.json'))) {
        if (existsSync(join(folder, PRESENCE_FILE)))
          copyFileSync(join(folder, PRESENCE_FILE), target)
        return
      }
      writeFileSync(target, `${JSON.stringify({ personId, ...dump(personId) }, null, 2)}\n`, {
        mode: 0o600,
      })
    },
    purge(personId) {
      sqlite
        .transaction(() => {
          for (const table of TABLES)
            sqlite.query(`DELETE FROM ${table} WHERE person_id = ?`).run(personId)
        })
        .immediate()
    },
  }
}
