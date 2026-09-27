// Online backup of the SQLite database (phase 4, docs/architecture/storage.md#backups). The only
// place that touches SQLite for backups (R-4).
// Placeholder (P4-K1): task P4-E1 implements it.

import { KeithError } from '@keith/sdk'

/**
 * Writes a consistent snapshot of the (possibly live, WAL-mode) database at `srcPath` to
 * `destPath`, which must not exist yet. The result opens on its own and passes
 * `PRAGMA integrity_check`. An aborted `signal` rejects and leaves no file at `destPath`.
 */
export async function backupDatabase(
  _srcPath: string,
  _destPath: string,
  _signal: AbortSignal,
): Promise<void> {
  throw new KeithError('INTERNAL', 'backupDatabase is not implemented yet (P4-E1)')
}
