// The file purge of the dreaming module (docs/specs/dreaming.md "Rule 8", docs/specs/db.md "Retention", ADR-0031 §8, P35.5.6).
// The prune tick calls it. An archive entry is purged 30 days after its marker date (superseded or expired); the preimages
// (undo folders) and the staged plans of a run are purged 7 days after the run ended. Each table that lost files is audited
// as one `data.pruned { table, count }` (table names `dreaming.archive`, `dreaming.undo`, `dreaming.staged`), counts only.
// A run that is still running, or that has no row, keeps its folder: its end is unknown.
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DreamingRepo } from '@keith/db'
import type { Audit } from '../../audit/index.ts'
import { memoryBase } from '../hippocampus.ts'
import { dayOf } from './collect.ts'
import { parseMemoryFile, renderMemoryFile } from './entries.ts'
import {
  ARCHIVE_TIER,
  checkedPersonId,
  memoryFileOf,
  outsideDirOf,
  writeMemoryFile,
} from './files.ts'

const DAY_MS = 86_400_000
/** Archive entries older than this many days (by their marker date) are purged. */
export const ARCHIVE_PURGE_DAYS = 30
/** Undo folders and staged plans are purged this many days after their run ended. */
export const RUN_FILES_PURGE_DAYS = 7

/** When a staged plan of a run that ended at `endedAt` (ms) is purged: the expiry the person is shown (FR3-18). */
export function stagedExpiresAt(endedAt: number): number {
  return endedAt + RUN_FILES_PURGE_DAYS * DAY_MS
}

export interface DreamPurgeOptions {
  dataDir: string
  repo: Pick<DreamingRepo, 'listRuns'>
  audit: Pick<Audit, 'record'>
  now?: () => number
}

/** Files removed by one purge, per table (archive entries, undo folders, staged plans). */
export interface DreamPurgeCounts {
  archive: number
  undo: number
  staged: number
}

/** The persons with a memory or an outside folder (a name that is not a valid person id is skipped). */
function personsOf(dataDir: string): string[] {
  const names = new Set<string>()
  for (const base of [memoryBase(dataDir), join(dataDir, 'dreams')]) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name)
    }
  }
  return [...names].filter((name) => {
    try {
      checkedPersonId(name)
      return true
    } catch {
      return false
    }
  })
}

/** Removes the archive entries whose marker date is before `cutDay`; returns how many. */
function purgeArchive(dataDir: string, personId: string, cutDay: string): number {
  const path = memoryFileOf(dataDir, personId, ARCHIVE_TIER)
  if (!existsSync(path)) return 0
  const blocks = parseMemoryFile(readFileSync(path, 'utf8'))
  const kept = blocks.filter(
    (block) =>
      !(block.kind === 'dream' && block.superseded !== undefined && block.superseded.date < cutDay),
  )
  const removed = blocks.length - kept.length
  // the memory folder is written only through the files.ts helpers (an atomic write, ADR-0031 §4)
  if (removed > 0) writeMemoryFile(dataDir, personId, ARCHIVE_TIER, renderMemoryFile(kept))
  return removed
}

/** Removes the undo folders and staged plans of the runs that ended before `cutMs`; returns the counts. */
function purgeRunFiles(
  dataDir: string,
  personId: string,
  endedOf: ReadonlyMap<string, number>,
  cutMs: number,
): { undo: number; staged: number } {
  const outside = outsideDirOf(dataDir, personId)
  const endedBefore = (runId: string): boolean => {
    const ended = endedOf.get(runId)
    return ended !== undefined && ended < cutMs
  }
  let undo = 0
  const undoBase = join(outside, 'undo')
  if (existsSync(undoBase)) {
    for (const name of readdirSync(undoBase)) {
      if (!endedBefore(name)) continue
      rmSync(join(undoBase, name), { recursive: true, force: true })
      undo += 1
    }
  }
  let staged = 0
  const stagedBase = join(outside, 'staged')
  if (existsSync(stagedBase)) {
    for (const name of readdirSync(stagedBase)) {
      if (!name.endsWith('.json') || !endedBefore(name.slice(0, -'.json'.length))) continue
      unlinkSync(join(stagedBase, name))
      staged += 1
    }
  }
  return { undo, staged }
}

/**
 * One purge over every person's archive, undo folders and staged plans. Audits each table with a count above zero. A
 * person whose files cannot be read is an error for the caller (the prune tick logs it and tries again next time).
 */
export function purgeDreamFiles(options: DreamPurgeOptions): DreamPurgeCounts {
  const now = (options.now ?? Date.now)()
  const archiveCut = dayOf(now - ARCHIVE_PURGE_DAYS * DAY_MS)
  const runCut = now - RUN_FILES_PURGE_DAYS * DAY_MS
  const counts: DreamPurgeCounts = { archive: 0, undo: 0, staged: 0 }
  for (const personId of personsOf(options.dataDir)) {
    counts.archive += purgeArchive(options.dataDir, personId, archiveCut)
    const endedOf = new Map<string, number>()
    for (const run of options.repo.listRuns(personId, Number.MAX_SAFE_INTEGER)) {
      if (run.endedAt !== null) endedOf.set(run.id, run.endedAt)
    }
    const files = purgeRunFiles(options.dataDir, personId, endedOf, runCut)
    counts.undo += files.undo
    counts.staged += files.staged
  }
  const tables: Array<[string, number]> = [
    ['dreaming.archive', counts.archive],
    ['dreaming.undo', counts.undo],
    ['dreaming.staged', counts.staged],
  ]
  for (const [table, count] of tables) {
    if (count > 0)
      options.audit.record({
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: { table, count },
      })
  }
  return counts
}
