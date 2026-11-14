/**
 * The real-data side of `eval:news --data` (FD11-07, docs/specs/evals.md): a copy of the owner's data folder that
 * the run may read and write, never the original. The database is copied with `VACUUM INTO` from a read-only
 * connection (one consistent file, the WAL included, while the core runs); the key and the two trees are copied
 * next to it. Nothing else is taken: no WAL or shared-memory file, no socket, no lock, no backup, export or log.
 */
import { Database } from 'bun:sqlite'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The entries of a data folder a `--data` copy takes, besides the database. */
export const COPIED_ENTRIES = ['secret.key', 'workspace', 'memory'] as const

/**
 * Copy `source` (a Keith data folder) into `target` (an existing, empty folder). Symbolic links are not followed or
 * copied. Throws when the database cannot be read; nothing is copied past that point.
 */
export function copyDataFolder(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(target, 0o700)
  const dbFile = join(source, 'keith.db')
  if (existsSync(dbFile)) {
    const copy = join(target, 'keith.db')
    const from = new Database(dbFile, { readonly: true })
    try {
      from.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
    } finally {
      from.close()
    }
    chmodSync(copy, 0o600)
  }
  for (const name of COPIED_ENTRIES) {
    const path = join(source, name)
    if (!existsSync(path)) continue
    cpSync(path, join(target, name), {
      recursive: true,
      filter: (from) => !lstatSync(from).isSymbolicLink(),
    })
  }
}

/**
 * Remove `dir` when the process ends, whatever ends it: the returned function (normal end of the run, the `finally`),
 * `exit`, `SIGINT` (exit 130) and `SIGTERM` (exit 143). `exit` is injectable for tests.
 */
export function trackTempDir(dir: string, exit: (code: number) => void = process.exit): () => void {
  const remove = (): void => rmSync(dir, { recursive: true, force: true })
  const onInt = (): void => {
    remove()
    exit(130)
  }
  const onTerm = (): void => {
    remove()
    exit(143)
  }
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  process.on('exit', remove)
  return () => {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    process.off('exit', remove)
    remove()
  }
}
