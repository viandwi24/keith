// Online backup of the SQLite database (docs/architecture/storage.md#backups). The only place that
// touches SQLite for backups (R-4).
//
// `bun:sqlite` has no binding for SQLite's online backup API (sqlite3_backup_*), so the snapshot is
// `VACUUM INTO` on a separate read-only connection. It runs in one read transaction, so the result
// is a consistent snapshot of the committed state (WAL included) while other connections keep
// writing, and it never blocks a writer.

import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, rm } from 'node:fs/promises'
import { KeithError } from '@keith/sdk'

/**
 * Writes a consistent snapshot of the (possibly live, WAL-mode) database at `srcPath` to
 * `destPath`, which must not exist yet. The result opens on its own and passes
 * `PRAGMA integrity_check`. An aborted `signal` rejects and leaves no file at `destPath`.
 */
export async function backupDatabase(srcPath: string, destPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!existsSync(srcPath)) {
    throw new KeithError('NOT_FOUND', `database not found: ${srcPath}`, { details: { path: srcPath } })
  }
  if (existsSync(destPath)) {
    throw new KeithError('INTERNAL', `backup target already exists: ${destPath}`, {
      details: { path: destPath },
    })
  }
  // Written under a temporary name next to the target and linked into place only once it is
  // verified, so neither an abort nor a crash leaves a partial file at `destPath`.
  const temp = `${destPath}.partial-${randomBytes(6).toString('hex')}`
  try {
    snapshot(srcPath, temp)
    signal.throwIfAborted()
    verify(temp)
    signal.throwIfAborted()
    // link() fails if `destPath` appeared meanwhile, where rename() would overwrite it.
    await link(temp, destPath)
  } finally {
    await rm(temp, { force: true })
  }
}

function snapshot(srcPath: string, destPath: string): void {
  let src: Database
  try {
    src = new Database(srcPath, { readonly: true, strict: true })
  } catch (cause) {
    throw new KeithError('INTERNAL', `cannot open database for backup: ${srcPath}`, {
      cause,
      details: { path: srcPath },
    })
  }
  try {
    src.run('PRAGMA busy_timeout = 5000')
    src.run('VACUUM INTO ?', [destPath])
  } catch (cause) {
    throw new KeithError('INTERNAL', `database backup failed: ${srcPath}`, {
      cause,
      details: { path: srcPath },
    })
  } finally {
    src.close()
  }
}

function verify(path: string): void {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const rows = db.query('PRAGMA integrity_check').values()
    const result = rows.map((r) => String(r[0])).join('; ')
    if (result !== 'ok') {
      throw new KeithError('STORAGE_CORRUPT', `backup failed its integrity check: ${result}`, {
        details: { path },
      })
    }
  } finally {
    db.close()
  }
}
