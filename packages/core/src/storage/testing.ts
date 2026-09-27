// Test helper for every lane: a real, migrated database in a temp folder, removed on close.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import type { Db } from './types.ts'

export type TestDb = Db & {
  /** The temp folder that holds the database file (a stand-in `KEITH_HOME`). */
  readonly dir: string
  /** Same as `close()`, for `using db = createTestDb()`. */
  [Symbol.dispose](): void
}

/**
 * Opens a fresh migrated database in a new temp folder. `close()` closes it and deletes the
 * folder. Use `using db = createTestDb()` or call `close()` in `afterEach`.
 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'keith-db-'))
  let db: Db
  try {
    db = openDb(join(dir, 'keith.db'))
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { path: db.path, repos: db.repos, dir, close, [Symbol.dispose]: close }
}
