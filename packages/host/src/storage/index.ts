import type { Database } from 'bun:sqlite'
import type { Clock, PluginStorage } from '../types.ts'
import { createKv } from './kv.ts'
import { createScopedDb } from './scoped-db.ts'
import { tablePrefix } from './sql-scope.ts'

export { KV_KEY, KV_KEYS_MAX, KV_VALUE_MAX } from './kv.ts'
export {
  assertPluginStorageMigrated,
  migratePluginStorage,
  pluginJournalState,
  pluginsWithStorage,
} from './migrate.ts'
export {
  assertMigrationSql,
  assertScopedSql,
  migrationsTableOf,
  ScopeError,
  tablePrefix,
} from './sql-scope.ts'

/**
 * The storage a guard hands to a plugin: its scoped Drizzle handle and its key-value store, made on
 * first use and kept (the handle reads the schema once, so call this after the migrations ran).
 */
export function createPluginStorage(
  sqlite: Database,
  clock: Clock = { now: Date.now },
): (pluginId: string) => PluginStorage {
  const made = new Map<string, PluginStorage>()
  return (pluginId) => {
    let storage = made.get(pluginId)
    if (storage === undefined) {
      storage = {
        db: createScopedDb(sqlite, pluginId, tablePrefix(pluginId)),
        kv: createKv(sqlite, pluginId, clock.now),
      }
      made.set(pluginId, storage)
    }
    return storage
  }
}
