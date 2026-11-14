// The files of one person's dreaming (docs/specs/dreaming.md "Files", ADR-0031 §2, §4, §8). Every path a dreaming call touches is
// named by a tier, never by a free string: a tier is one of the fixed memory files, a topic file or a diary date. The helpers
// below are the only way dreaming reads or writes the memory folder (undo and the applier call them, never `node:fs` directly).
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { DREAM_TOPIC_FILE_PATTERN } from '@keith/contracts'
import { SAFE_ID } from '../../../platform/workspace-resolve.ts'
import { memoryBase, memoryDir } from '../hippocampus.ts'

export const PROFILE_FILE = 'profile.md'
export const RECENT_FILE = 'recent.md'
export const ARCHIVE_FILE = 'archive.md'
/** The diary folder inside the memory folder: `memory/<personId>/dreams/`. */
export const DIARY_DIR = 'dreams'
/** The folder outside the memory mount: `<dataDir>/dreams/<personId>/{staged,undo}/`. */
export const OUTSIDE_DIR = 'dreams'
/** How long an `auto` run's preimages stay usable for `dream.undo` (ADR-0031 §5). */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const RESERVED_TOPICS: ReadonlySet<string> = new Set([PROFILE_FILE, RECENT_FILE, ARCHIVE_FILE])
const DIARY_PATH = /^dreams\/(\d{4}-\d{2}-\d{2})\.md$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** One file of a person's memory folder, by role. */
export type MemoryTier =
  | { readonly kind: 'profile' }
  | { readonly kind: 'recent' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'topic'; readonly name: string }
  | { readonly kind: 'diary'; readonly date: string }

export const PROFILE_TIER: MemoryTier = { kind: 'profile' }
export const RECENT_TIER: MemoryTier = { kind: 'recent' }
export const ARCHIVE_TIER: MemoryTier = { kind: 'archive' }

/** A topic tier. Refused: a name that is not `^[a-z0-9][a-z0-9-]{0,39}\.md$` (so no `..` and no separator) and the reserved names. */
export function topicTier(name: string): MemoryTier {
  if (!DREAM_TOPIC_FILE_PATTERN.test(name) || RESERVED_TOPICS.has(name)) {
    throw new Error(`not a topic file name: ${JSON.stringify(name)}`)
  }
  return { kind: 'topic', name }
}

/** A diary tier for one day (`dreams/<YYYY-MM-DD>.md` inside the memory folder). */
export function diaryTier(date: string): MemoryTier {
  if (!DATE.test(date)) throw new Error(`not a date: ${JSON.stringify(date)}`)
  return { kind: 'diary', date }
}

/** The path of a tier relative to the person's memory folder (`profile.md`, `dreams/2026-11-11.md`, …). */
export function tierPath(tier: MemoryTier): string {
  switch (tier.kind) {
    case 'profile':
      return PROFILE_FILE
    case 'recent':
      return RECENT_FILE
    case 'archive':
      return ARCHIVE_FILE
    case 'topic':
      return tier.name
    case 'diary':
      return `${DIARY_DIR}/${tier.date}.md`
  }
}

/** The tier a memory-relative path names, or undefined when it names none (used to check paths read back from disk). */
export function tierOfPath(relative: string): MemoryTier | undefined {
  if (relative === PROFILE_FILE) return PROFILE_TIER
  if (relative === RECENT_FILE) return RECENT_TIER
  if (relative === ARCHIVE_FILE) return ARCHIVE_TIER
  const diary = DIARY_PATH.exec(relative)
  if (diary !== null) return { kind: 'diary', date: diary[1] as string }
  if (DREAM_TOPIC_FILE_PATTERN.test(relative) && !RESERVED_TOPICS.has(relative)) {
    return { kind: 'topic', name: relative }
  }
  return undefined
}

/** A person id that may name a folder (the same rule as the workspace resolver). Throws otherwise. */
export function checkedPersonId(personId: string): string {
  if (!SAFE_ID.test(personId)) throw new Error(`not a person id: ${JSON.stringify(personId)}`)
  return personId
}

/** A run id that may name a file (a UUIDv7 in practice). Throws otherwise. */
export function checkedRunId(runId: string): string {
  if (!SAFE_ID.test(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`)
  return runId
}

/** Throws when `path` is the memory base or inside it: the staged and undo folders must stay outside the memory mount. */
export function assertOutsideMemory(dataDir: string, path: string): void {
  const base = resolve(memoryBase(dataDir))
  const target = resolve(path)
  if (target === base || target.startsWith(`${base}${sep}`)) {
    throw new Error(`dreaming path inside the memory folder: ${path}`)
  }
}

/** `<dataDir>/memory/<personId>/<tier path>`. */
export function memoryFileOf(dataDir: string, personId: string, tier: MemoryTier): string {
  return join(memoryDir(dataDir, checkedPersonId(personId)), tierPath(tier))
}

/** `<dataDir>/dreams/<personId>/`, outside the memory mount. */
export function outsideDirOf(dataDir: string, personId: string): string {
  const path = join(dataDir, OUTSIDE_DIR, checkedPersonId(personId))
  assertOutsideMemory(dataDir, path)
  return path
}

/** `<dataDir>/dreams/<personId>/staged/<runId>.json`: the plan of a `propose` run. */
export function stagedFileOf(dataDir: string, personId: string, runId: string): string {
  return join(outsideDirOf(dataDir, personId), 'staged', `${checkedRunId(runId)}.json`)
}

/** `<dataDir>/dreams/<personId>/undo/<runId>/`: the preimages of one run. */
export function undoDirOf(dataDir: string, personId: string, runId: string): string {
  return join(outsideDirOf(dataDir, personId), 'undo', checkedRunId(runId))
}

/** The bytes of a memory file, or undefined when it does not exist. */
export function readMemoryBytes(
  dataDir: string,
  personId: string,
  tier: MemoryTier,
): Uint8Array | undefined {
  const path = memoryFileOf(dataDir, personId, tier)
  return existsSync(path) ? readFileSync(path) : undefined
}

/** The text of a memory file (UTF-8), or undefined when it does not exist. */
export function readMemoryFile(
  dataDir: string,
  personId: string,
  tier: MemoryTier,
): string | undefined {
  const bytes = readMemoryBytes(dataDir, personId, tier)
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
}

/**
 * Writes a file atomically: the bytes go to a temporary file in the same folder, the file is fsynced, then renamed over the
 * target. A crash leaves the old file or the new one, never half of one. `beforeRename` runs between the temporary write and the
 * rename (a test makes it throw); a failure there removes the temporary file and leaves the target as it was.
 */
export function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: { beforeRename?: () => void } = {},
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${Bun.randomUUIDv7()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx' })
    const handle = openSync(temporary, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    options.beforeRename?.()
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Writes a memory file atomically, creating its folder. The only dreaming writer of the memory folder besides `removeMemoryFile`. */
export function writeMemoryFile(
  dataDir: string,
  personId: string,
  tier: MemoryTier,
  content: string | Uint8Array,
): void {
  writeFileAtomic(memoryFileOf(dataDir, personId, tier), content)
}

/** Removes a memory file if it exists. */
export function removeMemoryFile(dataDir: string, personId: string, tier: MemoryTier): void {
  rmSync(memoryFileOf(dataDir, personId, tier), { force: true })
}
