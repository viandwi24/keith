// Test helper for every lane: a real, migrated database in a temp folder, removed on close.

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonId, ThreadId } from '../shared/types.ts'
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

/**
 * Test-only (phase 5): marks a current participant as left (`left_at = at`) on a real database,
 * through its own connection. It lets tests build a "left" participant before
 * `ThreadsRepository.removeParticipant` exists (P5-S1). Returns whether a row changed.
 */
export function markParticipantLeft(
  db: Pick<Db, 'path'>,
  threadId: ThreadId,
  personId: PersonId,
  at: number,
): boolean {
  const sqlite = new Database(db.path, { strict: true })
  try {
    sqlite.run('PRAGMA busy_timeout = 5000')
    const result = sqlite
      .query(
        'update thread_participants set left_at = $at where thread_id = $threadId and person_id = $personId and left_at is null',
      )
      .run({ at, threadId, personId })
    return result.changes > 0
  } finally {
    sqlite.close()
  }
}
