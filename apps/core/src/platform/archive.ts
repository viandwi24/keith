// Tar archives for `keith-core backup`, `restore` and `people export` (docs/specs/backup.md, ADR-0006).
// `tar` runs through `Bun.spawn`: `Bun.Archive` builds an archive from an object with no per-entry mode (every
// file comes out 0644, an executable loses its bit), so the modes the owner or a worker set would not survive.
// A symlink is stored as a link and never followed. Extraction refuses an absolute name, a `..` part, a hard link or a
// device, and any entry written through a symlink (the link is made, nothing is ever written beneath it).
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export class ArchiveError extends Error {
  override readonly name = 'ArchiveError'
}

/** One entry of an archive: its name as stored and what it is. `other` is a hard link, a device or a FIFO. */
export interface ArchiveEntry {
  name: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
}

/** Names inside `dir` to put in the archive; each source contributes its own folder (tar `-C`). */
export interface ArchiveSource {
  dir: string
  names: readonly string[]
}

async function tar(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr: stderr.trim() }
}

/**
 * Write a tar of the names of each source. Modes are kept, a symlink is stored as a link and not followed. The file
 * is created with `wx` and mode 0600: an existing path is refused, and a failed run leaves nothing behind.
 */
export async function writeArchive(out: string, sources: readonly ArchiveSource[]): Promise<void> {
  const names = sources.reduce((n, s) => n + s.names.length, 0)
  if (names === 0) throw new ArchiveError('nothing to archive')
  try {
    closeSync(openSync(out, 'wx', 0o600))
  } catch (error) {
    throw new ArchiveError(`${out} cannot be created: ${reasonOf(error)}`)
  }
  const args = ['-cf', out]
  for (const source of sources) {
    if (source.names.length > 0) args.push('-C', source.dir, ...source.names)
  }
  const result = await tar(args)
  if (result.code !== 0) {
    rmSync(out, { force: true })
    throw new ArchiveError(`tar could not write ${out}: ${result.stderr || `exit ${result.code}`}`)
  }
}

/** Every entry with its kind, as stored. Reads the archive only; nothing is checked for safety here. */
export async function readEntries(archive: string): Promise<ArchiveEntry[]> {
  const verbose = await tar(['-tvf', archive])
  if (verbose.code !== 0)
    throw new ArchiveError(
      `${archive} is not a readable archive: ${verbose.stderr || 'tar failed'}`,
    )
  const names = await tar(['-tf', archive])
  if (names.code !== 0) throw new ArchiveError(`${archive} cannot be listed: ${names.stderr}`)
  const kinds = verbose.stdout.split('\n').filter((line) => line.length > 0)
  const list = names.stdout.split('\n').filter((line) => line.length > 0)
  if (kinds.length !== list.length)
    throw new ArchiveError(`${archive} lists ${list.length} names for ${kinds.length} entries`)
  return list.map((name, i) => {
    const type = kinds[i]?.[0]
    const kind = type === '-' ? 'file' : type === 'd' ? 'dir' : type === 'l' ? 'symlink' : 'other'
    return { name, kind }
  })
}

/** An entry name without a leading `./` or a trailing `/`. */
const normalize = (name: string): string => name.replace(/^(\.\/)+/, '').replace(/\/+$/, '')

/**
 * The entries of an archive, after the safety check, before anything is written: refuses an absolute name, a name with
 * a `..` part, a hard link, a device, and an entry written through a symlink (the link itself or anything beneath it).
 * Used by `extractArchive` and by `restore`.
 */
export async function listArchive(archive: string): Promise<string[]> {
  const entries = await readEntries(archive)
  const links: string[] = []
  for (const entry of entries) {
    const name = normalize(entry.name)
    if (isAbsolute(name) || name.split('/').includes('..'))
      throw new ArchiveError(`${entry.name} leaves the folder it is extracted into`)
    if (entry.kind === 'other')
      throw new ArchiveError(
        `${entry.name} is a hard link or a special file: not allowed in an archive`,
      )
    if (links.some((link) => name === link || name.startsWith(`${link}/`)))
      throw new ArchiveError(`${entry.name} is written through a link: refused`)
    if (entry.kind === 'symlink') links.push(name)
  }
  return entries.map((entry) => entry.name)
}

/** Extract an archive into `dest` (created 0700 when missing). Modes come from the archive, minus the umask. */
export async function extractArchive(archive: string, dest: string): Promise<void> {
  await listArchive(archive)
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  const result = await tar(['-xf', archive, '-C', dest, '--no-same-owner'])
  if (result.code !== 0)
    throw new ArchiveError(
      `${archive} could not be extracted: ${result.stderr || `exit ${result.code}`}`,
    )
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
