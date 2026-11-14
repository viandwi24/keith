import type { AclStore } from '@keith/acl'
import type { CapabilityRegistry, PersonRole } from '@keith/contracts'
import { reviewsRepo, type SettingsRepo, type Sqlite, sqliteSchedules } from '@keith/db'
import type { KeithPlugin, PeoplePort, ProtocolsPort, SchedulePort, WakePort } from '@keith/host'
import { createPluginStorage } from '@keith/host/storage'
import type { ActivityStore } from 'eharness/activity'
import type { AccessService, KindTable } from './modules/acl/index.ts'
import type { AclAudit, Audit } from './modules/audit/index.ts'
import type { Capabilities } from './modules/auth/index.ts'
import { withGuests } from './modules/guests/index.ts'
import type { PeopleService } from './modules/people/index.ts'
import {
  createAccessPort,
  createPeopleDirectory,
  createPluginAclAudit,
  createPluginAdmin,
  createPluginFeed,
  createPluginHost,
  createReviewService,
  createScheduleService,
  type PluginAdmin,
  type PluginHost,
  pluginEnabledKey,
  pluginScope,
  type ReviewService,
  type ScheduleService,
} from './modules/plugins/index.ts'
import type { Logger } from './platform/logger.ts'

export { pluginEnabledKey }

/** Wire the plugin host: the guard over the people directory, the ACL, the audit and the settings. No logic here. */
export async function createPlugins(options: {
  plugins: readonly KeithPlugin[]
  /** The core database: the scoped `db` and `kv` of plugins are made over it. */
  sqlite: Sqlite
  people: Pick<PeopleService, 'get' | 'owner'>
  capabilities: Capabilities
  registry: CapabilityRegistry
  acl: AclStore
  kinds: KindTable
  audit: Audit
  settings: SettingsRepo
  logger: Logger
  /** The activity feed: typed plugin events and notices are written to it. */
  store: ActivityStore
  /** The access service behind `k.access` (the one `acl.share` uses). */
  access: AccessService
  /** The ACL audit (`acl.owner-access` for the owner's root reads through `k.audit.ownerAccess`). */
  aclAudit: Pick<AclAudit, 'ownerAccess' | 'record' | 'denied'>
  /** Starts turns in front sessions (`createWake`). */
  wake: WakePort
  /** The protocol port of plugins (`k.protocols`), bound to the hypothalamus service (`modules/hypothalamus/host-port.ts`). */
  protocols?: ProtocolsPort
  /** Whether a guest session with this random id is live (`withGuests`): a guest principal resolves only while it is. */
  guestLive?: (randomId: string) => boolean
  /** Ticker and catch-up timing of the plugins' schedules (tests shorten them). */
  schedules?: { tickMs?: number; graceMs?: number }
}): Promise<
  PluginHost & { reviews: ReviewService; schedules: ScheduleService; admin: PluginAdmin }
> {
  const { settings, logger } = options
  const feed = createPluginFeed({ store: options.store, warn: (m) => logger.warn(m) })
  const directory = withGuests(
    createPeopleDirectory({
      people: options.people,
      capabilities: (personId: string, role: PersonRole) =>
        options.capabilities.of({ personId, role }),
    }),
    (id) => options.guestLive?.(id) ?? false,
  )
  // the review service replays through the host's guard and the host files reviews through the service's port
  const holder: { host?: PluginHost } = {}
  const reviews = createReviewService({
    repo: reviewsRepo(options.sqlite),
    host: () => holder.host as PluginHost,
    directory,
    people: options.people,
    audit: options.audit,
    settings,
    notify: feed.notice,
    warn: (m) => logger.warn(m),
  })
  // the scheduler needs the loaded plugins and the guard needs the scheduler's port: one holder
  const late: { schedules?: ScheduleService } = {}
  const schedulePort: SchedulePort = {
    set: (plugin, key, input) => (late.schedules as ScheduleService).port.set(plugin, key, input),
    get: (plugin, key) => (late.schedules as ScheduleService).port.get(plugin, key),
    cancel: (plugin, key) => (late.schedules as ScheduleService).port.cancel(plugin, key),
  }
  const storage = createPluginStorage(options.sqlite)
  const peoplePort: PeoplePort = {
    async find(query) {
      try {
        const p = await options.people.get(query.trim().toLowerCase())
        return p.status === 'active' ? { id: p.id, name: p.name, username: p.username } : undefined
      } catch {
        return undefined
      }
    },
    async name(personId) {
      try {
        return (await options.people.get(personId)).name
      } catch {
        return undefined
      }
    },
  }
  const host = await createPluginHost({
    plugins: options.plugins,
    directory,
    acl: options.acl,
    kinds: options.kinds,
    capabilities: options.registry,
    audit: options.audit,
    storage,
    // the ACL store and the plugin storage share this handle (docs/specs/plugins.md, Context `k`)
    transaction: (fn) => options.sqlite.transaction(fn).immediate(),
    schedule: schedulePort,
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
    access: createAccessPort(options.access, options.aclAudit),
    aclWrites: createPluginAclAudit(options.aclAudit),
    ownerAccess: (caller, access) => options.aclAudit.ownerAccess(caller, access),
    people: peoplePort,
    events: feed.events,
    notices: feed.notices,
    reviews: reviews.port,
    isEnabled: (id) => settings.get<boolean>(pluginEnabledKey(id)) !== false,
    logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
  })
  holder.host = host
  const scheduleStore = sqliteSchedules(options.sqlite)
  const schedules = createScheduleService({
    // the table is shared with the protocol triggers: the plugin scheduler sees its own rows only
    store: pluginScope(scheduleStore),
    plugins: () => host.loaded(),
    storage,
    directory,
    acl: options.acl,
    audit: options.audit,
    wake: options.wake,
    names: (personId) => peoplePort.name(personId),
    log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
    ...(options.schedules ?? {}),
  })
  late.schedules = schedules
  const admin = createPluginAdmin({
    plugins: options.plugins,
    host: () => host,
    settings,
    reviews,
    schedules: scheduleStore,
  })
  return Object.assign(host, { reviews, schedules, admin })
}
