import type { Database } from 'bun:sqlite'
import type { PluginKv } from '../types.ts'

export const KV_KEY = /^[A-Za-z0-9._:/@-]{1,128}$/
export const KV_VALUE_MAX = 64 * 1024
export const KV_KEYS_MAX = 10_000

/** The namespaced key-value store of one plugin: the core table `plugin_kv`, rows keyed by (plugin, key). */
export function createKv(sqlite: Database, pluginId: string, now: () => number): PluginKv {
  const bad = (key: string): never => {
    throw new Error(
      `kv: bad key (1 to 128 of letters, digits and . _ : / @ -): ${key.slice(0, 40)}`,
    )
  }
  return {
    get<T = unknown>(key: string): T | undefined {
      if (!KV_KEY.test(key)) return bad(key)
      const row = sqlite
        .query<{ value: string }, [string, string]>(
          'SELECT value FROM plugin_kv WHERE plugin = ? AND key = ?',
        )
        .get(pluginId, key)
      return row === null ? undefined : (JSON.parse(row.value) as T)
    },
    set(key, value) {
      if (!KV_KEY.test(key)) return bad(key)
      const json = JSON.stringify(value)
      if (json === undefined) throw new Error('kv: the value is not JSON')
      if (json.length > KV_VALUE_MAX) throw new Error(`kv: value over ${KV_VALUE_MAX} characters`)
      const write = sqlite.transaction(() => {
        const exists = sqlite
          .query('SELECT 1 FROM plugin_kv WHERE plugin = ? AND key = ?')
          .get(pluginId, key)
        if (exists === null) {
          const n =
            sqlite
              .query<{ n: number }, [string]>(
                'SELECT count(*) AS n FROM plugin_kv WHERE plugin = ?',
              )
              .get(pluginId)?.n ?? 0
          if (n >= KV_KEYS_MAX) throw new Error(`kv: more than ${KV_KEYS_MAX} keys`)
        }
        sqlite
          .query(
            `INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(pluginId, key, json, now())
      })
      write.immediate()
    },
    delete(key) {
      if (!KV_KEY.test(key)) return bad(key)
      return (
        sqlite.query('DELETE FROM plugin_kv WHERE plugin = ? AND key = ?').run(pluginId, key)
          .changes > 0
      )
    },
    list(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000)
      const prefix = options.prefix ?? ''
      const rows = sqlite
        .query<{ key: string; value: string }, [string, string, number]>(
          // substr compares the prefix literally (LIKE and GLOB would read % and * in it)
          `SELECT key, value FROM plugin_kv WHERE plugin = ?1 AND substr(key, 1, length(?2)) = ?2 ORDER BY key LIMIT ?3`,
        )
        .all(pluginId, prefix, limit)
      return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }))
    },
  }
}
