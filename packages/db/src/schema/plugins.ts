// Plugin key-value store (docs/specs/plugins.md, docs/specs/db.md).
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The key-value store of plugins (`ctx.kv`, docs/specs/plugins.md): JSON text keyed by plugin id and key. */
export const pluginKv = sqliteTable(
  'plugin_kv',
  {
    plugin: text('plugin').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.key] })],
)
