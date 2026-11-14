// A removed person's protocols, runs, proposals and agenda (ADR-0027 §26, docs/specs/hypothalamus.md "Removal of a person").
// `stop` disables their protocols and cancels their open runs before anything is kept, so nothing fires for them during
// the retention. `keep` writes one dump into the kept folder, the live rows stay until the keep time (as parietal does),
// `export` copies that dump or writes the live rows, and `purge` deletes them in dependency order.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sqlite } from '@keith/db'
import { type PersonRemovalHooks, removedFolderOf } from '../people/index.ts'

export const HYPOTHALAMUS_FILE = 'hypothalamus.json'

export interface HypothalamusRemovalOptions {
  sqlite: Sqlite
  dataDir: string
  /** Told after a change of the protocol rows (a disabled or deleted protocol): the cached set is refreshed. */
  onChange?: () => void
  /** Epoch ms; a test passes a fixed clock. */
  now?: () => number
}

/** The rows of one person, as the dump file holds them (every table with its own columns). */
function dumpOf(sqlite: Sqlite, personId: string): Record<string, unknown[]> {
  const select = (sql: string) => sqlite.query(sql).all(personId) as unknown[]
  return {
    protocols: select('SELECT * FROM protocols WHERE owner = ?'),
    protocol_versions: select(
      'SELECT * FROM protocol_versions WHERE protocol_id IN (SELECT id FROM protocols WHERE owner = ?)',
    ),
    protocol_runs: select('SELECT * FROM protocol_runs WHERE person = ?'),
    protocol_run_steps: select(
      'SELECT * FROM protocol_run_steps WHERE run_id IN (SELECT id FROM protocol_runs WHERE person = ?)',
    ),
    protocol_proposals: select('SELECT * FROM protocol_proposals WHERE person = ?'),
    agenda_items: select('SELECT * FROM agenda_items WHERE person = ?'),
  }
}

export function hypothalamusRemoval(options: HypothalamusRemovalOptions): PersonRemovalHooks {
  const { sqlite, dataDir } = options
  const now = options.now ?? Date.now
  const changed = (): void => options.onChange?.()
  const write = (path: string, personId: string) =>
    writeFileSync(path, `${JSON.stringify({ personId, ...dumpOf(sqlite, personId) }, null, 2)}\n`, {
      mode: 0o600,
    })

  return {
    stop(personId) {
      const at = now()
      sqlite
        .transaction(() => {
          sqlite
            .query('UPDATE protocols SET enabled = 0, updated_at = ? WHERE owner = ?')
            .run(at, personId)
          sqlite
            .query(
              `UPDATE protocol_runs SET status = 'cancelled', step = NULL, wake_at = NULL,
                 ended_at = ?, updated_at = ? WHERE person = ? AND status IN ('running', 'waiting')`,
            )
            .run(at, at, personId)
        })
        .immediate()
      changed()
    },
    keep(personId, folder) {
      write(join(folder, HYPOTHALAMUS_FILE), personId)
      return undefined
    },
    export(personId, dest) {
      const folder = removedFolderOf(dataDir, personId)
      const target = join(dest, HYPOTHALAMUS_FILE)
      // a removed person: the kept copy is the record; a live person: the rows as they are now
      if (existsSync(join(folder, 'manifest.json'))) {
        if (existsSync(join(folder, HYPOTHALAMUS_FILE)))
          copyFileSync(join(folder, HYPOTHALAMUS_FILE), target)
        return
      }
      write(target, personId)
    },
    purge(personId) {
      sqlite
        .transaction(() => {
          sqlite
            .query(
              'DELETE FROM protocol_run_steps WHERE run_id IN (SELECT id FROM protocol_runs WHERE person = ?)',
            )
            .run(personId)
          sqlite.query('DELETE FROM protocol_runs WHERE person = ?').run(personId)
          sqlite.query('DELETE FROM protocol_proposals WHERE person = ?').run(personId)
          sqlite.query('DELETE FROM agenda_items WHERE person = ?').run(personId)
          // versions go with their protocol (ON DELETE CASCADE); the runs above are gone first
          sqlite.query('DELETE FROM protocols WHERE owner = ?').run(personId)
        })
        .immediate()
      changed()
    },
  }
}
