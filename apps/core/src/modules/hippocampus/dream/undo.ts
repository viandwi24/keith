// Preimages of one dreaming run (docs/specs/dreaming.md "Rule 4" and "Undo", ADR-0031 §4). Before the first write of a memory file
// in a run, its previous bytes are copied to `<dataDir>/dreams/<personId>/undo/<runId>/<tier path>`. A file the run creates gets a
// `<tier path>.created` marker instead. A second write of the same file in the same run takes no second preimage, and that holds
// after a restart too, because the check reads the store on disk. Each write also records the SHA-256 the file should hold after it
// (`written.json`, next to the preimages). Restoring writes the saved bytes back only to a file that still holds what the run wrote
// (or its saved bytes), and removes the created files the same way; any other file is kept and named in the result.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  type MemoryTier,
  readMemoryBytes,
  removeMemoryFile,
  tierOfPath,
  tierPath,
  UNDO_WINDOW_MS,
  undoDirOf,
  writeFileAtomic,
  writeMemoryFile,
} from './files.ts'
import { contentHash } from './staged.ts'

/** The suffix of the marker a created file leaves in the undo folder. */
export const CREATED_SUFFIX = '.created'
/**
 * The record of a run's writes, at the root of its undo folder: each memory-relative path the run wrote maps to the SHA-256 the
 * file should hold after the write (null after a removal). A run written before this record has no such file: its restore is
 * unguarded, as it was.
 */
export const WRITTEN_FILE = 'written.json'

const WrittenSchema = z.record(
  z.string(),
  z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
)
type Written = z.infer<typeof WrittenSchema>

/** The record of the writes of a run, or undefined for a run written before the record. */
function readWritten(root: string): Written | undefined {
  const file = join(root, WRITTEN_FILE)
  if (!existsSync(file)) return undefined
  return WrittenSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

/** Adds one write to the record before the write lands: a write that fails leaves the file as it was, which the restore accepts. */
function recordWritten(root: string, path: string, hash: string | null): void {
  const written = readWritten(root) ?? {}
  writeFileAtomic(join(root, WRITTEN_FILE), JSON.stringify({ ...written, [path]: hash }))
}

/** One entry of an undo folder: a file to put back (`created` false) or a file the run created (`created` true). */
export interface Preimage {
  /** The memory-relative path, as `tierPath` writes it. */
  readonly path: string
  readonly tier: MemoryTier
  readonly created: boolean
}

/** The entries of one run's undo folder, sorted by path. Throws when the folder holds a path that no tier names. */
export function preimagesOf(dataDir: string, personId: string, runId: string): Preimage[] {
  const root = undoDirOf(dataDir, personId, runId)
  if (!existsSync(root)) return []
  const found: Preimage[] = []
  for (const entry of new Bun.Glob('**/*').scanSync({ cwd: root, dot: true, onlyFiles: true })) {
    if (entry === WRITTEN_FILE) continue
    const created = entry.endsWith(CREATED_SUFFIX)
    const path = created ? entry.slice(0, -CREATED_SUFFIX.length) : entry
    const tier = tierOfPath(path)
    if (tier === undefined)
      throw new Error(`undo store of run ${runId} holds a path no tier names: ${entry}`)
    found.push({ path, tier, created })
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Saves the preimage of `tier` for `runId` unless one exists already (a preimage or a created marker). */
function takePreimage(dataDir: string, personId: string, runId: string, tier: MemoryTier): void {
  const copy = join(undoDirOf(dataDir, personId, runId), tierPath(tier))
  const marker = `${copy}${CREATED_SUFFIX}`
  if (existsSync(copy) || existsSync(marker)) return
  const bytes = readMemoryBytes(dataDir, personId, tier)
  if (bytes === undefined) writeFileAtomic(marker, '')
  else writeFileAtomic(copy, bytes)
}

/** The writes of one run. Each call takes the preimage first, then writes through the `files.ts` helpers. */
export interface RunWriter {
  write(tier: MemoryTier, content: string | Uint8Array): void
  remove(tier: MemoryTier): void
}

/** Opens the writer of one run. Opening it writes nothing; the first `write` or `remove` of a file takes its preimage. */
export function openRunWriter(dataDir: string, personId: string, runId: string): RunWriter {
  return {
    write(tier, content) {
      takePreimage(dataDir, personId, runId, tier)
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      recordWritten(undoDirOf(dataDir, personId, runId), tierPath(tier), contentHash(bytes))
      writeMemoryFile(dataDir, personId, tier, content)
    },
    remove(tier) {
      takePreimage(dataDir, personId, runId, tier)
      recordWritten(undoDirOf(dataDir, personId, runId), tierPath(tier), null)
      removeMemoryFile(dataDir, personId, tier)
    },
  }
}

export interface RestoreResult {
  /** Files put back to their saved bytes. */
  readonly restored: number
  /** Files the run created that were deleted. */
  readonly removed: number
  /**
   * Memory-relative paths left as they are: the file changed after the run wrote it (a chat write or a newer run), so putting the
   * saved bytes back would lose that change.
   */
  readonly skipped: readonly string[]
}

type RestoreAction = 'write' | 'remove' | 'skip' | 'none'

/**
 * Undoes one run: restores each saved file to its exact bytes, deletes each created file, then removes the undo folder, so a second
 * restore finds nothing. A file the run wrote is touched only while it still holds what the run wrote, or its saved bytes (so a crash
 * midway can be repeated); any other file is skipped and named in the result. A run with no `written.json` (written before the
 * record) restores every file, as before. Every decision is taken before the first write; a bad path throws and changes nothing.
 */
export function restoreRun(dataDir: string, personId: string, runId: string): RestoreResult {
  const preimages = preimagesOf(dataDir, personId, runId)
  const root = undoDirOf(dataDir, personId, runId)
  const written = readWritten(root)
  const decided = preimages.map((preimage) => {
    const current = contentHash(readMemoryBytes(dataDir, personId, preimage.tier))
    const before = preimage.created ? null : contentHash(readFileSync(join(root, preimage.path)))
    // what the run left on disk; a path the record does not name must still hold what was there before the run
    const after =
      written === undefined ? undefined : preimage.path in written ? written[preimage.path] : before
    const restorable = after === undefined || current === after || current === before
    let action: RestoreAction
    if (preimage.created) action = current === null ? 'none' : restorable ? 'remove' : 'skip'
    else action = restorable ? 'write' : 'skip'
    return { preimage, action }
  })
  let restored = 0
  let removed = 0
  const skipped: string[] = []
  for (const { preimage, action } of decided) {
    if (action === 'write') {
      writeMemoryFile(dataDir, personId, preimage.tier, readFileSync(join(root, preimage.path)))
      restored += 1
    } else if (action === 'remove') {
      removeMemoryFile(dataDir, personId, preimage.tier)
      removed += 1
    } else if (action === 'skip') {
      skipped.push(preimage.path)
    }
  }
  rmSync(root, { recursive: true, force: true })
  return { restored, removed, skipped }
}

/** The end of the undo window of a run whose files were written at `writtenAt` (ms): 7 days (ADR-0031 §5). */
export function undoUntilFrom(writtenAt: number): number {
  return writtenAt + UNDO_WINDOW_MS
}

export type UndoDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'nothing-to-undo' }

/**
 * Whether `dream.undo` may restore a run now. Pure: the caller passes the clock and the stored `undo_until` (null for a run that
 * wrote nothing), plus whether the undo folder holds anything. The window is open while `now` is not past `undoUntil`.
 */
export function decideUndo(input: {
  readonly now: number
  readonly undoUntil: number | null
  readonly hasPreimages: boolean
}): UndoDecision {
  if (!input.hasPreimages) return { ok: false, reason: 'nothing-to-undo' }
  if (input.undoUntil === null || input.now > input.undoUntil)
    return { ok: false, reason: 'nothing-to-undo' }
  return { ok: true }
}
