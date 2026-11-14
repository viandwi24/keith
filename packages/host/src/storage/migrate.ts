import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { KeithPlugin } from '../types.ts'
import { assertMigrationSql, migrationsTableOf, ScopeError } from './sql-scope.ts'

/** The plugins that keep tables: those whose manifest names a migrations folder. */
export const pluginsWithStorage = (plugins: readonly KeithPlugin[]): KeithPlugin[] =>
  plugins.filter((p) => p.manifest.storage !== undefined)

function entriesOf(folder: string): number {
  const journal = resolve(folder, 'meta/_journal.json')
  if (!existsSync(journal)) return 0
  return (JSON.parse(readFileSync(journal, 'utf8')) as { entries: unknown[] }).entries.length
}

/**
 * Applies the pending migrations of every plugin that keeps tables, each in its own migrations
 * table (`__plg_<id>_migrations`), so plugins and the core never share a journal. Every statement is
 * checked first (`assertMigrationSql`): a migration that touches anything but `plg_<id>_*` is refused
 * before it runs. Idempotent. Run after the core's snapshot by `migrateWithBackup`, never by a running core.
 */
export function migratePluginStorage(sqlite: Database, plugins: readonly KeithPlugin[]): void {
  for (const plugin of pluginsWithStorage(plugins)) {
    const folder = (plugin.manifest.storage as { migrations: string }).migrations
    if (entriesOf(folder) === 0) continue
    for (const migration of readMigrationFiles({ migrationsFolder: folder })) {
      try {
        for (const statement of migration.sql) assertMigrationSql(statement, plugin.id)
      } catch (error) {
        const why = error instanceof ScopeError ? error.message : String(error)
        throw new Error(`plugin ${plugin.id}: migration refused: ${why}`)
      }
    }
    migrate(drizzle({ client: sqlite }), {
      migrationsFolder: folder,
      migrationsTable: migrationsTableOf(plugin.id),
    })
  }
}

/** A plugin's migrations table against its journal: the same rule as `journalStateOf` in `@keith/db`. */
export function pluginJournalState(
  sqlite: Database,
  plugin: KeithPlugin,
): { kind: 'ready' | 'behind' | 'ahead' | 'diverged'; applied: number; shipped: number } {
  const table = migrationsTableOf(plugin.id)
  const folder = (plugin.manifest.storage as { migrations: string }).migrations
  const shipped = existsSync(resolve(folder, 'meta/_journal.json'))
    ? readMigrationFiles({ migrationsFolder: folder })
    : []
  const has = sqlite
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table)
  const rows =
    has?.n === 1
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
  return { kind: 'ready', applied, shipped: shipped.length }
}

/**
 * Throws with the command to run when a plugin's tables are behind its shipped migrations, and refuses a
 * journal that a newer build wrote (ahead or diverged), with the same text as the core's.
 */
export function assertPluginStorageMigrated(
  sqlite: Database,
  plugins: readonly KeithPlugin[],
): void {
  for (const plugin of pluginsWithStorage(plugins)) {
    const state = pluginJournalState(sqlite, plugin)
    if (state.kind === 'behind')
      throw new Error(
        `plugin ${plugin.id}: database schema is behind (${state.applied}/${state.shipped} migrations): run \`bun run db:migrate\``,
      )
    if (state.kind === 'ahead' || state.kind === 'diverged')
      throw new Error(
        `plugin ${plugin.id}: this database was migrated by a newer Keith (${state.applied} applied, this build ships ${state.shipped}): update Keith, or \`keith-core restore\` a backup made before the upgrade`,
      )
  }
}
