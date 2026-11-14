// `keith-core people export` (ADR-0027 §26, docs/specs/people.md "Export"): an archive of one person's
// memory, workspace and conversations, written by the core for the owner only.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeArchive } from '../../platform/archive.ts'
import type { Audit } from '../audit/index.ts'
import type { PeopleCaller, PeopleService } from './people.ts'
import { PeopleError } from './people.ts'
import { type RemovalService, readRemovedManifest, removedFolderOf } from './removed.ts'

/** The archive written for one person: its path (in `<dataDir>/exports`), the person and the entries. */
export interface PersonExported {
  path: string
  personId: string
  files: number
}

/** What to export: a person by username or id, or a removed person by id while their data is kept. */
export interface PersonExportTarget {
  person?: string | undefined
  removed?: string | undefined
}

export interface PersonExportOptions {
  dataDir: string
  people: Pick<PeopleService, 'get' | 'requireOwner'>
  removal: Pick<RemovalService, 'exportData'>
  audit: Pick<Audit, 'record'>
  now?: () => number
}

export interface PersonExporter {
  exportPerson(target: PersonExportTarget, by: PeopleCaller): Promise<PersonExported>
}

/** Every regular file under `root` (symlinks are not followed), for the count in the result. */
function countFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name))
    else if (entry.isFile()) count += 1
  }
  return count
}

/** `2026-11-10T02:45:00.123Z` as `20261110T024500123`: sortable, safe in a file name. */
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace(/[-:.]/g, '')

export function createPersonExport(options: PersonExportOptions): PersonExporter {
  const now = options.now ?? Date.now
  return {
    async exportPerson(target, by) {
      await options.people.requireOwner(by, 'export a person')
      if ((target.person === undefined) === (target.removed === undefined))
        throw new PeopleError(
          'BAD_REQUEST',
          'name a person, or --removed <personId> for a removed one',
        )
      let personId: string
      let name: string
      const removed = target.removed !== undefined
      if (target.removed !== undefined) {
        const folder = removedFolderOf(options.dataDir, target.removed)
        const manifest = /^[A-Za-z0-9_-]{1,64}$/.test(target.removed)
          ? readRemovedManifest(folder)
          : undefined
        if (manifest === undefined)
          throw new PeopleError('NOT_FOUND', `no removed person ${target.removed} is kept`)
        personId = manifest.personId
        name = manifest.username ?? manifest.personId
      } else {
        const person = await options.people.get(target.person ?? '')
        personId = person.id
        name = person.username ?? person.id
      }

      const exportsDir = join(options.dataDir, 'exports')
      mkdirSync(exportsDir, { recursive: true, mode: 0o700 })
      const stage = mkdtempSync(join(exportsDir, '.stage-'))
      try {
        await options.removal.exportData(personId, stage)
        const at = now()
        const manifest = { personId, username: name, exportedAt: at, removed }
        writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: 0o600,
        })
        const path = join(exportsDir, `${name}-${stamp(at)}.tar`)
        // tar keeps the modes the files have (`Bun.Archive` would write every file 0644); mode 0600 for the archive
        await writeArchive(path, [{ dir: stage, names: readdirSync(stage) }])
        const count = countFiles(stage)
        options.audit.record({
          kind: 'person.exported',
          actor: by.actor,
          via: by.via,
          detail: { person: personId, subject: personId, removed, files: count },
        })
        // the owner read the member's memory, workspace and conversations: the member sees it as such
        options.audit.record({
          kind: 'acl.owner-access',
          actor: by.actor,
          via: by.via,
          detail: { kind: 'export', owner: personId, reason: 'export', count: 1 },
        })
        return { path, personId, files: count }
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
    },
  }
}
