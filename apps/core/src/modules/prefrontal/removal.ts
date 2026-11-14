// The prefrontal region's share of a removed person (ADR-0027 §26, docs/specs/prefrontal.md "Removal", P33.2.5). The persona is
// global and is never removed with a person. A person's own style row is kept with the rest of their data: `keep` writes it
// into the kept folder and deletes the row, because `person_style` references `people` without a cascade and the person row
// is deleted right after the keep runs (the undo puts the row back). `export` writes the person's own style lines (from the kept
// folder once removed, else from the live row). `purge` deletes what keep left.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersonStyle } from '@keith/contracts'
import type { PersonStyleRepo, Sqlite } from '@keith/db'
import { type PersonRemovalHooks, removedFolderOf } from '../people/index.ts'

/** The file of the kept folder (and of an export) that holds the person's own style lines. */
export const STYLE_FILE = 'style.json'

export interface PrefrontalRemovalOptions {
  styles: PersonStyleRepo
  sqlite: Sqlite
  dataDir: string
}

/** A raw `person_style` row, kept so an undo can put back exactly what keep took out. */
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

/** What the kept folder and an export hold: the person's own style and who last wrote it. */
export interface StyleDump {
  personId: string
  style: PersonStyle
  updatedAt: number
  updatedBy: string
}

export function prefrontalRemoval(options: PrefrontalRemovalOptions): PersonRemovalHooks {
  const { styles, sqlite, dataDir } = options

  const rowOf = (personId: string): StyleRow | null =>
    sqlite.query<StyleRow, [string]>('SELECT * FROM person_style WHERE person_id = ?').get(personId)

  return {
    keep(personId, folder) {
      const row = rowOf(personId)
      if (row === null) return undefined
      const record = styles.get(personId)
      if (record === undefined) return undefined
      const dump: StyleDump = {
        personId,
        style: record.style,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      }
      // the file first: a write that fails leaves the row where it was
      writeFileSync(join(folder, STYLE_FILE), `${JSON.stringify(dump, null, 2)}\n`, { mode: 0o600 })
      sqlite.query('DELETE FROM person_style WHERE person_id = ?').run(personId)
      return () => {
        sqlite
          .query(
            `INSERT INTO person_style (person_id, address, language, brevity, formality, gentle_topics, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.person_id,
            row.address,
            row.language,
            row.brevity,
            row.formality,
            row.gentle_topics,
            row.updated_at,
            row.updated_by,
          )
      }
    },

    export(personId, dest) {
      const folder = removedFolderOf(dataDir, personId)
      const target = join(dest, STYLE_FILE)
      // a removed person: the kept file is the record; a live person: the row as it is now
      if (existsSync(join(folder, 'manifest.json'))) {
        if (existsSync(join(folder, STYLE_FILE))) {
          mkdirSync(dest, { recursive: true })
          copyFileSync(join(folder, STYLE_FILE), target)
        }
        return
      }
      const record = styles.get(personId)
      if (record === undefined) return
      const dump: StyleDump = {
        personId,
        style: record.style,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      }
      mkdirSync(dest, { recursive: true })
      writeFileSync(target, `${JSON.stringify(dump, null, 2)}\n`, { mode: 0o600 })
    },

    purge(personId) {
      styles.delete(personId)
    },
  }
}
