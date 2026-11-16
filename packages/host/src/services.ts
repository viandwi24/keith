import { parseContributions } from './contributions.ts'
import type { Contribution, KeithPlugin, PluginServices } from './types.ts'

/**
 * What a plugin of a list may do at boot, from `requires`, `provides`, `extensionPoints` and `contributes` alone
 * (docs/specs/plugins.md, "Services" and "Extension points"): the order to boot them in (a provider or a declaring
 * plugin before the plugins that lean on it, otherwise the list order), the plugins that cannot boot, each with one
 * clear reason, the parsed contributions per point, and the contributions that are ignored (one warning line each).
 */
export interface BootPlan {
  order: KeithPlugin[]
  failed: Map<string, string>
  /** Point id -> the contributions to it, in boot order; only between plugins of `order`. */
  contributions: ReadonlyMap<string, readonly Contribution[]>
  /** One line per contributor and point whose declaring plugin is off or cannot load. */
  ignored: string[]
}

export interface PlanBootOptions {
  /** Plugins the caller already failed (a table prefix clash in the core), with their reason: they cannot load. */
  failed?: ReadonlyMap<string, string>
}

/**
 * Orders `plugins` by dependency. A plugin fails when: another plugin already provides one of its services,
 * a service it requires is provided by nobody (or only by a plugin that is off or failed), it contributes to a
 * point nobody declares or with an entry the point's schema refuses, or it sits on a dependency cycle (every
 * plugin of the cycle fails and the message lists the loop). A contribution to a point whose declaring plugin is
 * off or failed is ignored with a warning; the contributor still boots. `enabled` says which plugins are on; a
 * disabled plugin neither boots nor provides.
 */
export function planBoot(
  plugins: readonly KeithPlugin[],
  enabled: (id: string) => boolean,
  options: PlanBootOptions = {},
): BootPlan {
  const failed = new Map<string, string>(options.failed ?? [])
  const live = plugins.filter((p) => enabled(p.id))
  const providerOf = new Map<string, string>()
  for (const p of live)
    for (const s of p.manifest.provides ?? []) {
      const taken = providerOf.get(s)
      if (taken === undefined) providerOf.set(s, p.id)
      else if (!failed.has(p.id)) failed.set(p.id, `service "${s}" is already provided by ${taken}`)
    }
  const off = new Map<string, string>()
  for (const p of plugins)
    if (!enabled(p.id)) for (const s of p.manifest.provides ?? []) off.set(s, p.id)
  // a point id -> its declaring plugin (on or off)
  const ownerOf = new Map<string, KeithPlugin>()
  for (const p of plugins)
    for (const point of Object.keys(p.manifest.extensionPoints ?? {}))
      if (!ownerOf.has(point)) ownerOf.set(point, p)
  const pointsOf = (p: KeithPlugin): string[] => Object.keys(p.manifest.contributes ?? {})
  const parsed = new Map<string, ReturnType<typeof parseContributions>>()
  const parse = (p: KeithPlugin, owner: KeithPlugin, point: string) => {
    const key = `${p.id}\u0000${point}`
    let result = parsed.get(key)
    if (result === undefined) {
      result = parseContributions(p, owner, point)
      parsed.set(key, result)
    }
    return result
  }

  // a missing provider or point fails the plugin, and so on down the chain
  const reasonOf = (p: KeithPlugin): string | undefined => {
    for (const s of p.manifest.requires ?? []) {
      const provider = providerOf.get(s)
      if (provider === undefined)
        return off.has(s)
          ? `requires service "${s}", provided by ${off.get(s)} which is off`
          : `requires service "${s}", which no plugin provides`
      if (failed.has(provider))
        return `requires service "${s}", provided by ${provider} which cannot load`
    }
    for (const point of pointsOf(p)) {
      const owner = ownerOf.get(point)
      if (owner === undefined) return `contributes to "${point}", which no plugin declares`
      // an owner that is off or failed: ignored below, the contributor still boots
      if (!enabled(owner.id) || (owner.id !== p.id && failed.has(owner.id))) continue
      const result = parse(p, owner, point)
      if (!result.ok) return result.reason
    }
    return undefined
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const p of live) {
      if (failed.has(p.id)) continue
      const reason = reasonOf(p)
      if (reason === undefined) continue
      failed.set(p.id, reason)
      changed = true
    }
  }

  // the plugins each one boots after: its providers and the owners of the points it contributes to
  const edgesOf = (p: KeithPlugin): string[] => {
    const edges = (p.manifest.requires ?? []).map((s) => providerOf.get(s) as string)
    for (const point of pointsOf(p)) {
      const owner = ownerOf.get(point)
      if (owner !== undefined && owner.id !== p.id && enabled(owner.id) && !failed.has(owner.id))
        edges.push(owner.id)
    }
    return edges
  }

  // order: repeatedly take the first plugin (list order) whose dependencies are all placed
  const pending = live.filter((p) => !failed.has(p.id))
  const placed = new Set<string>()
  const order: KeithPlugin[] = []
  while (pending.length > 0) {
    const i = pending.findIndex((p) => edgesOf(p).every((id) => placed.has(id)))
    if (i === -1) break
    const [next] = pending.splice(i, 1) as [KeithPlugin]
    placed.add(next.id)
    order.push(next)
  }
  // what is left waits on something that never gets placed: a cycle, or a plugin behind one
  const left = new Set(pending.map((p) => p.id))
  const edges = new Map(pending.map((p) => [p.id, edgesOf(p)]))
  for (const p of pending) {
    const loop = cycleFrom(p.id, edges, left)
    failed.set(
      p.id,
      loop === undefined
        ? 'depends on a plugin that is part of a dependency cycle'
        : `dependency cycle: ${loop.join(' -> ')}`,
    )
  }

  // contributions between plugins that boot; the rest are ignored with one line each
  const contributions = new Map<string, Contribution[]>()
  const ignored: string[] = []
  for (const p of order)
    for (const point of pointsOf(p)) {
      const owner = ownerOf.get(point) as KeithPlugin
      if (!enabled(owner.id) || failed.has(owner.id)) {
        ignored.push(
          `contributions of ${p.id} to "${point}" are ignored: ${owner.id} ${enabled(owner.id) ? 'cannot load' : 'is off'}`,
        )
        continue
      }
      const result = parse(p, owner, point)
      if (!result.ok) continue // unreachable: reasonOf failed the plugin
      const list = contributions.get(point) ?? []
      list.push(...result.contributions)
      contributions.set(point, list)
    }
  return { order, failed, contributions, ignored }
}

/** The loop through `start` (`a -> b -> a`), or undefined when `start` only leans on one. */
function cycleFrom(
  start: string,
  edges: ReadonlyMap<string, readonly string[]>,
  left: ReadonlySet<string>,
): string[] | undefined {
  const walk = (id: string, path: string[]): string[] | undefined => {
    if (id === start && path.length > 0) return [...path, id]
    if (path.includes(id)) return undefined
    for (const next of edges.get(id) ?? []) {
      if (!left.has(next)) continue
      const found = walk(next, [...path, id])
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(start, [])
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
