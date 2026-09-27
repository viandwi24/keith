import { KeithError, type ServiceMap, type ServiceName, type ServiceRegistry } from '@keith/sdk'
import type { Logger } from '../shared/types.ts'
import type { CoreServiceRegistry, PluginOwner } from './types.ts'

export type ServiceRegistryDeps = {
  /** `config.services`: service name → the plugin id that wins when several provide it. */
  winners: Record<string, string>
  log: Logger
}

/**
 * Named in-process services. Providing a taken name throws `SERVICE_CONFLICT`, unless
 * `[services]` in config names a winner: then only the winner's implementation is kept and the
 * others are ignored (logged). The setup-only / start-or-later rules are enforced by the plugin
 * host, which knows each plugin's phase.
 */
export function createServiceRegistry(deps: ServiceRegistryDeps): CoreServiceRegistry {
  const entries = new Map<string, { impl: unknown; pluginId: string }>()

  const get = <K extends ServiceName>(name: K): ServiceMap[K] => {
    const entry = entries.get(name)
    if (!entry) {
      throw new KeithError('SERVICE_MISSING', `service '${name}' is not provided by any plugin`, {
        details: { service: name },
      })
    }
    return entry.impl as ServiceMap[K]
  }
  const find = <K extends ServiceName>(name: K): ServiceMap[K] | undefined =>
    entries.get(name)?.impl as ServiceMap[K] | undefined

  return {
    get,
    find,
    forPlugin(owner: PluginOwner): ServiceRegistry {
      return {
        provide(name, impl) {
          const winner = deps.winners[name]
          if (winner !== undefined && winner !== owner.pluginId) {
            deps.log.info('service provider ignored', { service: name, pluginId: owner.pluginId, winner })
            return
          }
          const existing = entries.get(name)
          if (existing && winner === undefined) {
            throw new KeithError(
              'SERVICE_CONFLICT',
              `service '${name}' is already provided by ${existing.pluginId}; pick one with [services] ${name} = "<plugin id>"`,
              { details: { service: name, pluginId: owner.pluginId, existing: existing.pluginId } },
            )
          }
          entries.set(name, { impl, pluginId: owner.pluginId })
        },
        get,
        find,
      }
    },
    removeByPlugin(pluginId) {
      for (const [name, entry] of entries) if (entry.pluginId === pluginId) entries.delete(name)
    },
  }
}
