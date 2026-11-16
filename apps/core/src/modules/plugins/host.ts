import type { AclStore } from '@keith/acl'
import type { CapabilityRegistry, DeclaredCapability } from '@keith/contracts'
import {
  type AccessPort,
  type AclWriteAudit,
  type ActorDirectory,
  type AuditPort,
  type Clock,
  type Contribution,
  createGuard,
  createServiceRegistry,
  type EventPort,
  type Guard,
  type KeithPlugin,
  type NotifyPort,
  type OwnerAccessPort,
  type PeoplePort,
  type PluginStorage,
  type ProtocolsPort,
  planBoot,
  type ResolvedOperation,
  type ReviewPort,
  readContributions,
  type SchedulePort,
  type Surface,
} from '@keith/host'
import { tablePrefix } from '@keith/host/storage'
import { createViewAccess, type ViewAccess } from '@keith/host/views'
import type { HarnessPlugin } from 'eharness'
import type { KindTable } from '../acl/index.ts'
import { compilePlugin } from './adapter.ts'

export type PluginState = 'loaded' | 'disabled' | 'failed'

export interface PluginStatus {
  id: string
  version: string
  state: PluginState
  /** Short, safe reason for `failed` (never a stack or a secret). */
  reason?: string
}

export interface PluginHostDeps {
  /** The static list, in boot order (`BUILTIN_PLUGINS`; tests pass their own). */
  plugins: readonly KeithPlugin[]
  directory: ActorDirectory
  acl: AclStore
  kinds: KindTable
  capabilities: CapabilityRegistry
  audit: AuditPort
  /** The enable setting of a plugin, read at boot (`plugins.<id>.enabled`, default true). */
  isEnabled(id: string): boolean
  logger: { info(message: string): void; warn(message: string): void }
  clock?: Clock
  /** The scoped `db` and `kv` of a plugin (`createPluginStorage` over the core database). */
  storage?: (pluginId: string) => PluginStorage
  /** One write transaction over the core database (`k.transaction`); the same handle as `storage` and the ACL. */
  transaction?: <T>(fn: () => T) => T
  /** Where typed events and notices go (core: the activity feed, `createPluginFeed`). */
  events?: EventPort
  notices?: NotifyPort
  /** The owner review queue (`createReviewService().port`). */
  reviews?: ReviewPort
  /** The scheduler's port (`k.schedule`). */
  schedule?: SchedulePort
  /** The protocol port (`k.protocols`, docs/specs/plugins/reminders.md, "Internals"). */
  protocols?: ProtocolsPort
  /** The access service's port (`k.access`). */
  access?: AccessPort
  /** Names of people (`k.people`). */
  people?: PeoplePort
  /** The ACL audit of the owner's root reads (`k.audit.ownerAccess`). */
  ownerAccess?: OwnerAccessPort
  /** The ACL audit of the plugins' own resource writes (`acl.create`, `acl.remove`). */
  aclWrites?: AclWriteAudit
  /** The validated config of a plugin (default: empty). */
  config?: (pluginId: string) => Readonly<Record<string, unknown>>
  /** `start` that does not settle in this time fails the plugin (default 10 s). */
  startTimeoutMs?: number
}

export interface PluginHost {
  readonly guard: Guard
  /** Which terminal views a person may see and open (ADR-0018): the menu and the open check. */
  readonly views: ViewAccess
  /** The plugins that loaded, in boot order. */
  loaded(): KeithPlugin[]
  /** What to hand to the front agent: one eharness plugin per loaded plugin. */
  harnessPlugins(): HarnessPlugin[]
  status(): PluginStatus[]
  /** The operations of the loaded plugins that this person sees on a surface (actor facts only; the catalog and OpenAPI use it). */
  visibleOperations(principalId: string | undefined, surface: Surface): Promise<ResolvedOperation[]>
  /** The capabilities the loaded plugins added to the closed set (the owner sees them). */
  capabilities(): DeclaredCapability[]
  /**
   * The contributions to any extension point (ADR-0038), for the platform: only between plugins that loaded (the
   * declaring plugin and the contributor), each entry parsed by the point's schema and tagged with its contributor.
   */
  contributions(point: string): readonly Contribution[]
  close(): Promise<void>
}

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

/**
 * The loader (docs/specs/plugins.md, "Compile to eharness and load"). The list is static. Each plugin boots
 * on its own: a failure is logged and marked, never thrown, so one bad plugin cannot stop the core.
 */
export async function createPluginHost(deps: PluginHostDeps): Promise<PluginHost> {
  const clock = deps.clock ?? { now: Date.now }
  const guard = createGuard({
    directory: deps.directory,
    acl: deps.acl,
    audit: deps.audit,
    clock,
    log: deps.logger,
    plugin: (id) => byId.get(id),
    services: (plugin) => registry.viewFor(plugin),
    contributions: (_pluginId, point) => liveContributions(point),
    ...(deps.storage === undefined ? {} : { storage: deps.storage }),
    ...(deps.transaction === undefined ? {} : { transaction: deps.transaction }),
    ...(deps.events === undefined ? {} : { events: deps.events }),
    ...(deps.notices === undefined ? {} : { notices: deps.notices }),
    ...(deps.reviews === undefined ? {} : { reviews: deps.reviews }),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    ...(deps.protocols === undefined ? {} : { protocols: deps.protocols }),
    ...(deps.access === undefined ? {} : { access: deps.access }),
    ...(deps.people === undefined ? {} : { people: deps.people }),
    ...(deps.ownerAccess === undefined ? {} : { ownerAccess: deps.ownerAccess }),
    ...(deps.aclWrites === undefined ? {} : { aclWrites: deps.aclWrites }),
    ...(deps.config === undefined ? {} : { config: deps.config }),
  })
  const rows: PluginStatus[] = []
  const rowOf = new Map<string, number>() // plugin id -> its row (the first plugin with that id)
  const put = (plugin: KeithPlugin, row: Omit<PluginStatus, 'id' | 'version'>): void => {
    rows[rowOf.get(plugin.id) as number] = {
      id: plugin.id,
      version: plugin.manifest.version,
      ...row,
    }
  }
  const loaded: KeithPlugin[] = []
  const compiled: HarnessPlugin[] = []
  const stops: Array<{ id: string; stop: () => void | Promise<void> }> = []
  const abort = new AbortController()
  const registry = createServiceRegistry()
  const byId = new Map<string, KeithPlugin>()
  const dropped = new Set<string>() // plugins that failed: their points and their contributions are gone
  const fail = (plugin: KeithPlugin, reason: string): void => {
    deps.logger.warn(`plugins: ${plugin.id} failed: ${reason}`)
    put(plugin, { state: 'failed', reason })
    dropped.add(plugin.id)
  }

  // which plugins may boot at all: unique ids, enabled, table prefixes that do not nest
  const unique: KeithPlugin[] = []
  const candidates: KeithPlugin[] = []
  const clashed = new Map<string, string>()
  const prefixes: string[] = []
  for (const plugin of deps.plugins) {
    if (rowOf.has(plugin.id)) {
      deps.logger.warn(`plugins: ${plugin.id} failed: another plugin has this id`)
      rows.push({
        id: plugin.id,
        version: plugin.manifest.version,
        state: 'failed',
        reason: 'another plugin has this id',
      })
      continue
    }
    rowOf.set(plugin.id, rows.length)
    rows.push({ id: plugin.id, version: plugin.manifest.version, state: 'failed' })
    unique.push(plugin)
    if (!deps.isEnabled(plugin.id)) {
      put(plugin, { state: 'disabled' })
      continue
    }
    // `plg_a_` is a prefix of `plg_a_b_`: two plugins whose table prefixes nest could reach each other's tables
    if (plugin.manifest.storage !== undefined) {
      const prefix = tablePrefix(plugin.id)
      const clash = prefixes.find((p) => p.startsWith(prefix) || prefix.startsWith(p))
      if (clash !== undefined) {
        const reason = `its table prefix nests with ${clash}`
        fail(plugin, reason)
        clashed.set(plugin.id, reason)
        continue
      }
      prefixes.push(prefix)
    }
    candidates.push(plugin)
  }
  // provider and declaring plugin before the plugins that lean on them; a missing provider or point, a duplicate
  // provider, a contribution that does not fit or a cycle fails the plugin with the reason. Disabled plugins are
  // passed too, so a contribution to their points is ignored (not failed) and a missing provider says "off".
  const plan = planBoot(unique, (id) => deps.isEnabled(id), { failed: clashed })
  for (const plugin of candidates) {
    const reason = plan.failed.get(plugin.id)
    if (reason !== undefined) fail(plugin, reason)
  }
  for (const line of plan.ignored) deps.logger.warn(`plugins: ${line}`)
  const ownerOfPoint = (point: string): string => point.slice(0, point.indexOf('.'))
  const liveContributions = (point: string): readonly Contribution[] =>
    dropped.has(ownerOfPoint(point))
      ? []
      : (plan.contributions.get(point) ?? []).filter((c) => !dropped.has(c.contributor))

  for (const plugin of plan.order) {
    try {
      const missing = (plugin.manifest.requires ?? []).filter((s) => !registry.has(s))
      if (missing.length > 0)
        throw new Error(`requires service "${missing[0]}", whose provider did not load`)
      const kinds = Object.entries(plugin.manifest.resources ?? {})
      for (const [name] of kinds)
        if (deps.kinds.get(name) !== undefined) throw new Error(`resource kind "${name}" is taken`)
      deps.capabilities.register(plugin.id, plugin.manifest.permissions ?? [])
      for (const [name, def] of kinds) deps.kinds.register(name, def)
      const started = plugin.manifest.start?.({
        id: plugin.id,
        config: deps.config?.(plugin.id) ?? {},
        acl: deps.acl,
        clock,
        log: {
          info: (m) => deps.logger.info(`plugins: ${plugin.id}: ${m}`),
          warn: (m) => deps.logger.warn(`plugins: ${plugin.id}: ${m}`),
        },
        signal: abort.signal,
        provide: (serviceId, impl) => registry.provide(plugin, serviceId, impl),
        services: registry.viewFor(plugin),
        emit: (name, data, to) => guard.publisher.emit(plugin, name, data, to),
        contributions: (point) => readContributions(plugin, point, liveContributions),
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = await Promise.race([
        Promise.resolve(started),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('start did not finish in time')),
            deps.startTimeoutMs ?? 10_000,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      if (typeof stop === 'function') stops.push({ id: plugin.id, stop })
      const unmet = registry.missing(plugin)
      if (unmet.length > 0) throw new Error(`did not provide ${unmet.join(', ')}`)
      compiled.push(compilePlugin(plugin, { guard, directory: deps.directory }))
      loaded.push(plugin)
      byId.set(plugin.id, plugin)
      put(plugin, { state: 'loaded' })
    } catch (error) {
      deps.capabilities.unregister(plugin.id)
      registry.withdraw(plugin.id)
      fail(plugin, reasonOf(error))
    }
  }
  if (loaded.length > 0) deps.logger.info(`plugins: loaded ${loaded.map((p) => p.id).join(', ')}`)

  return {
    guard,
    views: createViewAccess({ directory: deps.directory, plugins: () => loaded }),
    loaded: () => [...loaded],
    harnessPlugins: () => [...compiled],
    status: () => rows.map((s) => ({ ...s })),
    async visibleOperations(principalId, surface) {
      const facts =
        principalId === undefined || principalId === ''
          ? undefined
          : await deps.directory.resolve(principalId)
      return guard.catalog(loaded, facts, surface)
    },
    capabilities: () => deps.capabilities.declared(),
    contributions: (point) => [...liveContributions(point)],
    async close() {
      abort.abort()
      for (const { id, stop } of stops.reverse()) {
        try {
          await stop()
        } catch (error) {
          deps.logger.warn(`plugins: ${id} did not stop cleanly: ${reasonOf(error)}`)
        }
      }
    },
  }
}
