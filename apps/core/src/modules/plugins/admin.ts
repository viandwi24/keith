import type { PluginDetail, PluginInfo, PluginToggle } from '@keith/contracts'
import type { KeithPlugin } from '@keith/host'
import type { ScheduleStore } from 'eharness/scheduler'
import type { PluginHost } from './host.ts'
import type { ReviewService } from './reviews.ts'

/** The setting that turns a plugin off at boot; absent means on (read once per boot, `compose-plugins.ts`). */
export const pluginEnabledKey = (id: string): string => `plugins.${id}.enabled`

export class PluginAdminError extends Error {
  readonly code = 'NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'PluginAdminError'
  }
}

export interface PluginAdmin {
  list(): Promise<PluginInfo[]>
  show(id: string): Promise<PluginDetail>
  /** Saves `plugins.<id>.enabled`; it applies at the next boot. `changed` is false when the setting already said so. */
  setEnabled(id: string, enabled: boolean): Promise<PluginToggle>
}

export interface PluginAdminDeps {
  /** The static list of built-in plugins (loaded or not: a disabled plugin still shows its operations). */
  plugins: readonly KeithPlugin[]
  host: () => PluginHost
  settings: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  reviews: Pick<ReviewService, 'list'>
  schedules: Pick<ScheduleStore, 'list'>
}

const MAX_PENDING_SCAN = 500

/**
 * What the operator sees of the plugin layer (`keith-core plugin`, the "Plugins" section of `keith manage`). Reads the
 * loader's status and the static list; the only write is the enable setting, which the next boot reads.
 */
export function createPluginAdmin(deps: PluginAdminDeps): PluginAdmin {
  const find = (id: string): KeithPlugin => {
    const plugin = deps.plugins.find((p) => p.id === id)
    if (plugin === undefined)
      throw new PluginAdminError(`no plugin "${id}" (see \`keith-core plugin list\`)`)
    return plugin
  }
  const pending = async (): Promise<Map<string, number>> => {
    const rows = await deps.reviews.list({ status: 'pending', limit: MAX_PENDING_SCAN })
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.plugin, (counts.get(r.plugin) ?? 0) + 1)
    return counts
  }
  const infoOf = (plugin: KeithPlugin, counts: Map<string, number>): PluginInfo => {
    const status = deps
      .host()
      .status()
      .find((s) => s.id === plugin.id)
    const state =
      status === undefined || status.state === 'failed'
        ? 'failed'
        : status.state === 'loaded'
          ? 'enabled'
          : 'disabled'
    const nextBoot =
      deps.settings.get<boolean>(pluginEnabledKey(plugin.id)) === false ? 'disabled' : 'enabled'
    return {
      id: plugin.id,
      version: plugin.manifest.version,
      title: plugin.manifest.title ?? null,
      state,
      reason: status?.reason ?? null,
      nextBoot,
      // a failed plugin stays failed until the cause is fixed; only enabled <-> disabled flips with the setting
      restartPending: state !== 'failed' && state !== nextBoot,
      pendingReviews: counts.get(plugin.id) ?? 0,
    }
  }
  return {
    async list() {
      const counts = await pending()
      return deps.plugins.map((p) => infoOf(p, counts))
    },
    async show(id) {
      const plugin = find(id)
      const info = infoOf(plugin, await pending())
      let schedules: PluginDetail['schedules'] = null
      if (info.state === 'enabled') {
        const rows = await deps.schedules.list({
          sessionId: `plugin:${plugin.id}`,
          state: 'active',
        })
        const next = rows.items
          .map((s) => s.nextFireAt)
          .filter((n): n is number => n !== null)
          .sort((a, b) => a - b)[0]
        schedules = { active: rows.items.length, nextAt: next ?? null }
      }
      return {
        ...info,
        description: plugin.manifest.description ?? null,
        capabilities: (plugin.manifest.permissions ?? []).map((c) => ({
          id: c.id,
          description: c.description,
          roles: [...(c.roles ?? [])],
        })),
        operations: plugin.operations.map((o) => ({
          name: o.name,
          description: o.description,
          capability: o.permission.capability,
          audience: o.audience,
          risk: o.risk,
          review: o.review !== undefined,
          ai: o.expose.ai,
          http: o.expose.http,
        })),
        schedules,
      }
    },
    async setEnabled(id, enabled) {
      const plugin = find(id)
      const was = deps.settings.get<boolean>(pluginEnabledKey(id)) !== false
      deps.settings.set(pluginEnabledKey(id), enabled)
      return {
        plugin: infoOf(plugin, await pending()),
        changed: was !== enabled,
        effective: 'next-boot',
      }
    },
  }
}
