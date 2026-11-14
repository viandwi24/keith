import type { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { PluginDb } from '../types.ts'
import { assertScopedSql } from './sql-scope.ts'

/** Names of every table and index in the database that `pluginId` does not own, lowercase. */
export function foreignNames(sqlite: Database, prefix: string): Set<string> {
  const rows = sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
    .all()
  return new Set(rows.map((r) => r.name.toLowerCase()).filter((n) => !n.startsWith(prefix)))
}

/**
 * The Drizzle handle of one plugin. Drizzle is built over a client that only forwards
 * `prepare`, `exec` and `transaction`, and every statement is read by `assertScopedSql` first, so a
 * plugin cannot reach a core table, another plugin's table, DDL or a pragma. The schema is read
 * once, when the handle is made (after the migrations ran).
 */
export function createScopedDb(sqlite: Database, pluginId: string, prefix: string): PluginDb {
  const foreign = foreignNames(sqlite, prefix)
  const client = {
    prepare(sql: string) {
      assertScopedSql(sql, pluginId, foreign)
      return sqlite.prepare(sql)
    },
    exec(sql: string) {
      assertScopedSql(sql, pluginId, foreign)
      return sqlite.exec(sql)
    },
    transaction: sqlite.transaction.bind(sqlite),
  }
  return drizzle({ client: client as unknown as Database })
}
