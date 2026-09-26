import { KeithError, type PluginDataStore } from '@keith/sdk'
import type { Clock } from '../shared/types.ts'
import type { PluginDataRepository } from '../storage/types.ts'
import type { PluginOwner, PluginScoped } from './types.ts'

export type PluginDataDeps = { repo: PluginDataRepository; clock: Clock }

function assertKey(key: string, pluginId: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new KeithError('INTERNAL', `plugin ${pluginId}: data keys must be non-empty strings`, {
      details: { pluginId },
    })
  }
}

/**
 * `ctx.data`: a key-value store per plugin id on top of the `plugin_data` repository. Values are
 * normalized through JSON so the repository only ever sees plain JSON. Data outlives a failed
 * plugin: `removeByPlugin` does not delete it.
 */
export function createPluginDataStores(deps: PluginDataDeps): PluginScoped<PluginDataStore> {
  return {
    forPlugin(owner: PluginOwner): PluginDataStore {
      const id = owner.pluginId
      return {
        async get<T = unknown>(key: string): Promise<T | undefined> {
          assertKey(key, id)
          const value = await deps.repo.get(id, key)
          return value === null || value === undefined ? undefined : (value as T)
        },
        async set(key, value) {
          assertKey(key, id)
          const json = value === undefined ? undefined : JSON.stringify(value)
          if (json === undefined) {
            throw new KeithError('INTERNAL', `plugin ${id}: value for '${key}' is not JSON-serializable`, {
              details: { pluginId: id, key },
            })
          }
          await deps.repo.set(id, key, JSON.parse(json), deps.clock.now())
        },
        async delete(key) {
          assertKey(key, id)
          await deps.repo.delete(id, key)
        },
        async list(prefix) {
          return deps.repo.list(id, prefix)
        },
      }
    },
    removeByPlugin() {
      // Stored data is not a registration: it survives a failed start and a restart.
    },
  }
}
