import { Database } from 'bun:sqlite'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { backfillPeople } from './repos/people-backfill.ts'

/** Generated SQL migrations of this package (`bun run db:generate`). */
export const MIGRATIONS_DIR: string = resolve(import.meta.dir, '../drizzle')

/**
 * Open (creating the folder) a database file or `:memory:`. WAL and `busy_timeout` let two
 * processes share the file; the adapters take write locks with `BEGIN IMMEDIATE`.
 */
export function openDatabase(file: string): Database {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true })
    // the file holds sealed credentials and the whole history: owner-only from the first byte
    if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600))
  }
  const sqlite = new Database(file, { create: true, strict: true })
  // busy_timeout first: setting the journal mode takes a lock, and without the timeout a database another process holds for a
  // moment (a core that is still closing, a keith-core command) fails at once with "database is locked"
  sqlite.exec('PRAGMA busy_timeout = 5000')
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  return sqlite
}

/** Apply every pending migration, then the idempotent data backfill. Callers snapshot a behind database first (`migrateWithBackup`, `apps/core/src/platform/db.ts`). */
export function migrateDatabase(sqlite: Database): void {
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_DIR })
  backfillPeople(sqlite)
}

/** How a migrations table (`__drizzle_migrations` or a plugin's) compares with the journal a build ships. */
export type JournalState =
  | { kind: 'ready' }
  | { kind: 'behind'; applied: number; shipped: number }
  | { kind: 'ahead'; applied: number; shipped: number }
  | { kind: 'diverged'; applied: number; shipped: number }

/**
 * Compares the rows of a migrations table (`hash`, `created_at`, in applied order) with the migrations of
 * `folder`. More rows than shipped: `ahead` (a newer build migrated it). A row of the shared prefix whose hash
 * or `created_at` differs: `diverged` (not this build's history). Fewer rows: `behind`. A missing table has none.
 */
export function journalStateOf(sqlite: Database, table: string, folder: string): JournalState {
  const shipped = existsSync(resolve(folder, 'meta/_journal.json'))
    ? readMigrationFiles({ migrationsFolder: folder })
    : []
  const present =
    sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.n === 1
  const rows = present
    ? sqlite
        .query<{ hash: string; created_at: number }, []>(
          `SELECT hash, created_at FROM "${table}" ORDER BY id`,
        )
        .all()
    : []
  const applied = rows.length
  if (applied > shipped.length) return { kind: 'ahead', applied, shipped: shipped.length }
  for (const [i, row] of rows.entries()) {
    const want = shipped[i]
    if (
      want === undefined ||
      row.hash !== want.hash ||
      Number(row.created_at) !== want.folderMillis
    )
      return { kind: 'diverged', applied, shipped: shipped.length }
  }
  if (applied < shipped.length) return { kind: 'behind', applied, shipped: shipped.length }
  return { kind: 'ready' }
}

/** The refusal text for a database migrated by another build (ahead or diverged). */
export function newerKeithMessage(applied: number, shipped: number): string {
  return `this database was migrated by a newer Keith (${applied} applied, this build ships ${shipped}): update Keith, or \`keith-core restore\` a backup made before the upgrade`
}

/** Throws when the core's migrations are behind (the command to run), ahead or diverged (refused, see `newerKeithMessage`). */
export async function assertMigrated(sqlite: Database): Promise<void> {
  const state = journalStateOf(sqlite, '__drizzle_migrations', MIGRATIONS_DIR)
  if (state.kind === 'behind')
    throw new Error(
      `database schema is behind (${state.applied}/${state.shipped} migrations): run \`bun run db:migrate\``,
    )
  if (state.kind === 'ahead' || state.kind === 'diverged')
    throw new Error(newerKeithMessage(state.applied, state.shipped))
}
