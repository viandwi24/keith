import type { KeithPlugin, PluginServices } from './types.ts'

/**
 * What a plugin of a list may do at boot, from `requires` and `provides` alone (docs/specs/plugins.md,
 * "Services"): the order to boot them in (a provider before its consumers, otherwise the list order) and
 * the plugins that cannot boot, each with one clear reason.
 */
export interface BootPlan {
  order: KeithPlugin[]
  failed: Map<string, string>
}

/**
 * Orders `plugins` by dependency. A plugin fails when: another plugin already provides one of its services,
 * a service it requires is provided by nobody (or only by a plugin that is off or failed), or it sits on a
 * dependency cycle (every plugin of the cycle fails and the message lists the loop). `enabled` says which
 * plugins are on; a disabled plugin neither boots nor provides.
 */
export function planBoot(
  plugins: readonly KeithPlugin[],
  enabled: (id: string) => boolean,
): BootPlan {
  const failed = new Map<string, string>()
  const live = plugins.filter((p) => enabled(p.id))
  const providerOf = new Map<string, string>()
  for (const p of live)
    for (const s of p.manifest.provides ?? []) {
      const taken = providerOf.get(s)
      if (taken === undefined) providerOf.set(s, p.id)
      else failed.set(p.id, `service "${s}" is already provided by ${taken}`)
    }
  const off = new Map<string, string>()
  for (const p of plugins)
    if (!enabled(p.id)) for (const s of p.manifest.provides ?? []) off.set(s, p.id)

  // a missing provider fails the consumer, and so on down the chain
  for (let changed = true; changed; ) {
    changed = false
    for (const p of live) {
      if (failed.has(p.id)) continue
      for (const s of p.manifest.requires ?? []) {
        const provider = providerOf.get(s)
        if (provider === undefined) {
          failed.set(
            p.id,
            off.has(s)
              ? `requires service "${s}", provided by ${off.get(s)} which is off`
              : `requires service "${s}", which no plugin provides`,
          )
        } else if (failed.has(provider)) {
          failed.set(p.id, `requires service "${s}", provided by ${provider} which cannot load`)
        } else continue
        changed = true
        break
      }
    }
  }

  // order: repeatedly take the first plugin (list order) whose providers are all placed
  const pending = live.filter((p) => !failed.has(p.id))
  const placed = new Set<string>()
  const order: KeithPlugin[] = []
  while (pending.length > 0) {
    const i = pending.findIndex((p) =>
      (p.manifest.requires ?? []).every((s) => placed.has(providerOf.get(s) as string)),
    )
    if (i === -1) break
    const [next] = pending.splice(i, 1) as [KeithPlugin]
    placed.add(next.id)
    order.push(next)
  }
  // what is left waits on something that never gets placed: a cycle, or a plugin behind one
  const left = new Set(pending.map((p) => p.id))
  for (const p of pending) {
    const loop = cycleFrom(p, pending, providerOf, left)
    failed.set(
      p.id,
      loop === undefined
        ? 'depends on a plugin that is part of a dependency cycle'
        : `dependency cycle: ${loop.join(' -> ')}`,
    )
  }
  return { order, failed }
}

/** The loop through `start` (`a -> b -> a`), or undefined when `start` only leans on one. */
function cycleFrom(
  start: KeithPlugin,
  pending: readonly KeithPlugin[],
  providerOf: ReadonlyMap<string, string>,
  left: ReadonlySet<string>,
): string[] | undefined {
  const byId = new Map(pending.map((p) => [p.id, p]))
  const walk = (id: string, path: string[]): string[] | undefined => {
    if (id === start.id && path.length > 0) return [...path, id]
    if (path.includes(id)) return undefined
    for (const s of byId.get(id)?.manifest.requires ?? []) {
      const next = providerOf.get(s)
      if (next === undefined || !left.has(next)) continue
      const found = walk(next, [...path, id])
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(start.id, [])
}

/** The services provided so far; a plugin sees only what it `requires`. */
export interface ServiceRegistry {
  /** Called from a plugin's `start`: only an id in its `provides`, once. */
  provide(plugin: KeithPlugin, serviceId: string, impl: unknown): void
  /** What a plugin may read: the services it declared in `requires`. */
  viewFor(plugin: KeithPlugin): PluginServices
  /** Whether a service has been provided. */
  has(serviceId: string): boolean
  /** The services a plugin declared in `provides` but did not provide (a boot error). */
  missing(plugin: KeithPlugin): string[]
  /** Forget what a plugin provided (it failed or stopped). */
  withdraw(pluginId: string): void
}

export function createServiceRegistry(): ServiceRegistry {
  const impls = new Map<string, { plugin: string; impl: unknown }>()
  return {
    provide(plugin, serviceId, impl) {
      if (!(plugin.manifest.provides ?? []).includes(serviceId))
        throw new Error(`service "${serviceId}" is not in provides of ${plugin.id}`)
      if (impls.has(serviceId)) throw new Error(`service "${serviceId}" is already provided`)
      impls.set(serviceId, { plugin: plugin.id, impl })
    },
    viewFor(plugin) {
      const allowed = new Set(plugin.manifest.requires ?? [])
      return {
        get<T = unknown>(id: string): T {
          if (!allowed.has(id)) throw new Error(`service "${id}" is not in requires`)
          const entry = impls.get(id)
          if (entry === undefined) throw new Error(`service "${id}" is not available`)
          return entry.impl as T
        },
      }
    },
    has: (serviceId) => impls.has(serviceId),
    missing: (plugin) =>
      (plugin.manifest.provides ?? []).filter((s) => impls.get(s)?.plugin !== plugin.id),
    withdraw(pluginId) {
      for (const [id, e] of impls) if (e.plugin === pluginId) impls.delete(id)
    },
  }
}
