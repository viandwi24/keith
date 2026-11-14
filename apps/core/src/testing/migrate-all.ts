import { migrateDatabase, type Sqlite } from '@keith/db'
import { migratePluginStorage } from '@keith/host/storage'
import { BUILTIN_PLUGINS } from '../modules/plugins/index.ts'

/** Tests that boot a core: the core's migrations, then those of the built-in plugins (what `bun run db:migrate` does). */
export function migrateAll(sqlite: Sqlite): void {
  migrateDatabase(sqlite)
  migratePluginStorage(sqlite, BUILTIN_PLUGINS)
}
