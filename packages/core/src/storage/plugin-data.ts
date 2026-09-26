// plugin_data repository: a small JSON key-value store per plugin.

import { KeithError } from '@keith/sdk'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Orm, parseJson } from './orm.ts'
import { pluginData } from './schema.ts'
import type { PluginDataRepository } from './types.ts'

const JsonValue = z.unknown()

export function createPluginDataRepository(db: Orm): PluginDataRepository {
  return {
    /** Returns undefined when the key is missing. */
    async get(pluginId, key) {
      const row = db
        .select({ value: pluginData.value })
        .from(pluginData)
        .where(and(eq(pluginData.pluginId, pluginId), eq(pluginData.key, key)))
        .get()
      if (!row) return undefined
      return parseJson(JsonValue, row.value, {
        table: 'plugin_data',
        column: 'value',
        id: `${pluginId}/${key}`,
      })
    },
    async set(pluginId, key, value, updatedAt) {
      const json = JSON.stringify(value)
      if (json === undefined) {
        throw new KeithError('INTERNAL', 'plugin data value is not json-serializable', {
          details: { pluginId, key },
        })
      }
      db.insert(pluginData)
        .values({ pluginId, key, value: json, updatedAt })
        .onConflictDoUpdate({
          target: [pluginData.pluginId, pluginData.key],
          set: { value: json, updatedAt },
        })
        .run()
    },
    async delete(pluginId, key) {
      db.delete(pluginData)
        .where(and(eq(pluginData.pluginId, pluginId), eq(pluginData.key, key)))
        .run()
    },
    async list(pluginId, prefix) {
      const byPrefix =
        prefix === undefined || prefix === '' ? undefined : sql`instr(${pluginData.key}, ${prefix}) = 1`
      return db
        .select({ key: pluginData.key })
        .from(pluginData)
        .where(and(eq(pluginData.pluginId, pluginId), byPrefix))
        .orderBy(asc(pluginData.key))
        .all()
        .map((r) => r.key)
    },
  }
}
