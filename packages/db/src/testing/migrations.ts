import type { Database } from 'bun:sqlite'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { MIGRATIONS_DIR } from '../connection.ts'

const dirs: string[] = []

/** Removes every temp folder made by `migrationsBefore`; call from `afterAll`. */
export function cleanMigrationDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/**
 * A copy of `drizzle/` whose journal stops before the first migration whose tag starts with
 * `prefix` (`'0009_'`), with that migration and every later one removed. Used to build a fresh temp
 * database in the state before a migration, fill it with rows and migrate it forward.
 */
export function migrationsBefore(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'keith-mig-'))
  dirs.push(dir)
  cpSync(MIGRATIONS_DIR, join(dir, 'drizzle'), { recursive: true })
  const folder = join(dir, 'drizzle')
  const journalPath = join(folder, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] }
  const at = journal.entries.findIndex((e) => e.tag.startsWith(prefix))
  if (at < 0) throw new Error(`no migration starts with ${prefix}`)
  const removed = journal.entries.splice(at)
  writeFileSync(journalPath, JSON.stringify(journal))
  for (const entry of removed) unlinkSync(join(folder, `${entry.tag}.sql`))
  return folder
}

/**
 * Apply the core migrations of `folder` (a copy from `migrationsBefore`) with drizzle's migrator and nothing
 * else: no backfill, no plugin journals. Builds the previous schema for an upgrade drill.
 */
export function migrateFolder(sqlite: Database, folder: string): void {
  migrate(drizzle({ client: sqlite }), { migrationsFolder: folder })
}
