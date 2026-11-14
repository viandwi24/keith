import {
  type Health,
  IDENTITY_CHANGED,
  type LocalTrust,
  type NodeCapabilitySpec,
} from '@keith/contracts'
import {
  deviceRequestsRepo,
  dreamingRepo,
  frontGenerationsRepo,
  pairingRepo,
  protocolsRepo,
  type SqliteAcl,
  settingsRepo,
  sqliteActivityStore,
  sqliteCatalogCache,
  sqliteInbox,
  sqliteLock,
  sqliteMessages,
  sqliteProfileStore,
  sqliteState,
  sqliteStreamLog,
  tasksRepo,
} from '@keith/db'
import type { KeithPlugin } from '@keith/host'
import type { ViewHost } from '@keith/host/views'
import type { Server, WebSocketHandler } from 'bun'
import { type HarnessAgent, uuidv7 } from 'eharness'
import {
  type AnyProviderDefinition,
  type ManagerCatalogOptions,
  sealedProfileStore,
} from 'eharness/providers'
import { createActivityCapture } from './compose-activity.ts'
import { createDeliveryService } from './compose-delivery.ts'
import { createDreaming } from './compose-dreaming.ts'
import { createIdentity } from './compose-identity.ts'
import { createParietal } from './compose-parietal.ts'
import { createPrefrontal } from './compose-prefrontal.ts'
import { createProtocols } from './compose-protocols.ts'
import { type Wiring, wireEdge, wireFront } from './compose-regions.ts'
import { createRooms } from './compose-rooms.ts'
import {
  type CoreTiming,
  createApprovalExpiry,
  createProtocolTimer,
  createPrune,
  createReconcile,
  DEFAULT_TIMING,
} from './compose-timers.ts'
import type { SocketData, ViewLimitsForTests } from './compose-views.ts'
import type { KindTable } from './modules/acl/index.ts'
import { effectiveNetwork, type Network } from './modules/admin/index.ts'
import {
  attentionOptions,
  createApprovalSettings,
  openQueueSession,
  watchPending,
} from './modules/amygdala/index.ts'
import { createAuditRetention } from './modules/audit/index.ts'
import {
  createDeviceLogin,
  createLocalAccess,
  createPolicyStore,
  type HasherOptions,
} from './modules/auth/index.ts'
import { emit } from './modules/brain-events/index.ts'
import { createBudget, createUnpriced, routeUnpriced } from './modules/budget/index.ts'
import type { RoomToolCall } from './modules/corpus-callosum/index.ts'
import type { GuestAudit, GuestRegistry } from './modules/guests/index.ts'
import { dreamFlushPlugin } from './modules/hippocampus/dream/flush-hook.ts'
import { purgeDreamFiles } from './modules/hippocampus/dream/purge.ts'
import { dreamingRemoval } from './modules/hippocampus/dream/removal.ts'
import {
  createProtocolCatalog,
  delegatingProtocolsPort,
  dreamSettingsOf,
} from './modules/hypothalamus/index.ts'
import { REMOVED_KEEP_MS } from './modules/people/index.ts'
import { BUILTIN_PLUGINS, type PluginHost } from './modules/plugins/index.ts'
import { createProviderService, createUnreadableKeys } from './modules/providers/index.ts'
import { instanceIdOf, STREAM_RETENTION_MS } from './modules/resume/index.ts'
import type { GuestHttp } from './modules/thalamus/index.ts'
import { frontGenerations } from './modules/wernicke-broca/index.ts'
import type { Config } from './platform/config.ts'
import { openKeithDatabase } from './platform/db.ts'
import { type Logger, toHarnessLogger } from './platform/logger.ts'
import { frontSessionId } from './platform/sessions.ts'
import { createVault } from './platform/vault.ts'
import { buildInfo } from './platform/version.ts'

export type { CoreTiming } from './compose-timers.ts'

export interface CoreOptions {
  config: Config
  logger: Logger
  /** Extra provider definitions (plugins later, `scriptedProvider` in tests). */
  definitions?: AnyProviderDefinition[]
  catalogs?: ManagerCatalogOptions
  /** Timers of the background machinery (ms); tests shorten them. */
  timing?: Partial<CoreTiming>
  /**
   * Id of this core among the instances sharing one database. Default: the one kept in
   * `<dataDir>/instance-id`. Tests that run two cores on one data folder give each its own.
   */
  instanceId?: string
  /** Test only: a cheaper argon2 cost and queue limits (`createHasher`). */
  hasher?: HasherOptions
  /** Test only: the local trust of a person with no stored setting (default `none`, the product default). */
  localTrust?: LocalTrust | undefined
  /** Test only: the clock of the local socket's idle-lock. */
  localClock?: () => number
  /** The built-in plugins in boot order (default `BUILTIN_PLUGINS`); tests pass their own. */
  plugins?: readonly KeithPlugin[]
  /** Test only: the limits of plugin terminal views (idle, caps, frame rate) and the audit/open windows. */
  views?: ViewLimitsForTests
  /** Test only: the machine names the guest listener's Host guard accepts (default: this machine's hostname). */
  guestHosts?: () => readonly string[]
  /** Test only: the clock of guest sessions (idle and absolute expiry) and of the per-address start window. */
  guestClock?: () => number
  /** Test only: how often open streams are re-checked against their credential (default 30 s). */
  streamSweepMs?: number
  /** Test only: called for every call of a room tool, with the principal the call saw (`createRoomAgent`). */
  onRoomToolCall?: (call: RoomToolCall) => void
  /**
   * Capability specs added to the built-in ones at boot (node-drivers.md, "Core: registry"): the registry freezes
   * when the nodes module is built. A driver the core does not ship (a test fake) is registered here.
   */
  nodeCapabilities?: readonly NodeCapabilitySpec[]
}

export interface Core {
  /**
   * The server's `fetch`: `/nodes/ws` and `/plugins/views/ws` are authenticated and upgraded here (Bun's native
   * WebSocket); everything else is the Hono app. `server` is only missing in direct calls.
   */
  fetch: (
    request: Request,
    server?: Server<SocketData>,
  ) => Response | undefined | Promise<Response | undefined>
  /** Pass to `Bun.serve({ websocket })` next to `fetch`: node connections and plugin views, dispatched on `ws.data.kind`. */
  websocket: WebSocketHandler<SocketData>
  /**
   * The same app for the owner-only Unix socket (`listenLocal`): requests are the owner without a
   * token. The only WebSocket upgrade here is `/plugins/views/ws` (`/nodes/ws` is TCP only); it follows the
   * socket's rules: a locked socket answers 423 and trust `none` needs a bearer.
   */
  fetchLocal: (request: Request, server?: Server<undefined>) => Promise<Response | undefined>
  /** The ACL store over the core database (resources, groups; docs/specs/acl.md). Plugins consume it from P16. */
  acl: SqliteAcl
  /** Register a resource kind here before using it: an unknown kind is denied. */
  kinds: KindTable
  /** The plugin host: what loaded, what failed, the guard every operation passes (docs/specs/plugins.md). */
  plugins: PluginHost
  /** The open plugin terminal views (docs/specs/plugin-views.md): `snapshot()` lists them. */
  views: Pick<ViewHost, 'snapshot'>
  /** How many view sockets are connected. */
  viewSockets: () => number
  /**
   * The live guest sessions (`guests.md`): in memory only. The guest HTTP layer opens sessions here; the owner's
   * `admin.guests.*` list and end them.
   */
  guests: GuestRegistry
  /**
   * The guest listener's `fetch` and where it should listen (`guests.md`, "Guest HTTP"): `/health` and `/guest/*` only,
   * never the owner API. The process that listens (`createGuestListener`) is the caller's, as for `fetch`.
   */
  guestHttp: GuestHttp
  /** Recording of guest mode: `flush(true)` writes the refusal windows now (tests, shutdown); `close` does it too. */
  guestAudit: GuestAudit
  /** Effective bind address, port and public URL right now (env, then settings, then defaults). */
  network(): Network
  /** The process that listens tells the core where it is bound (`admin.access.get`). */
  announce(bound: { host: string; port: number }): void
  health: Health
  /** The activity logs (ADR-0032): `flush()` writes the calls queued so far (tests read the rows after it). */
  activity: { flush(): Promise<void> }
  close(): Promise<void>
}

/**
 * Wire the core: the shared machinery here (database, vault, identity, providers, the clock of the background
 * timers), then the regions (`compose-regions.ts`: front, HTTP edge) and the timers (`compose-timers.ts`).
 */
export async function createCore(options: CoreOptions): Promise<Core> {
  const { config, logger } = options
  const sqlite = await openKeithDatabase(config.dataDir, config.dbFile, options.plugins)
  // the current front generation of each person, read before any front session is recovered (ADR-0030 §2)
  const generations = frontGenerations(frontGenerationsRepo(sqlite))
  generations.load()
  const { vault, devKey } = createVault(config.secretKey, config.dataDir)
  if (devKey)
    logger.warn(`KEITH_SECRET_KEY is not set: using the dev key ${config.dataDir}/secret.key`)

  const identity = createIdentity(sqlite, {
    ...(options.hasher === undefined ? {} : { hasher: options.hasher }),
    ...(options.streamSweepMs === undefined ? {} : { streamSweepMs: options.streamSweepMs }),
    warn: (message) => logger.warn(message),
    removal: {
      dataDir: config.dataDir,
      keepMs: options.timing?.removedKeepMs ?? REMOVED_KEEP_MS,
    },
  })
  const { tokens, credentials, auditLog, audit, secrets, hasher } = identity
  const settings = settingsRepo(sqlite)
  const policies = createPolicyStore(settings, (message) => logger.warn(message))
  const local = createLocalAccess({
    settings,
    tokens,
    secrets,
    credentials,
    hasher,
    audit,
    ...(options.localClock === undefined ? {} : { now: options.localClock }),
    ...(options.localTrust === undefined ? {} : { defaultTrust: options.localTrust }),
    warn: (message) => logger.warn(message),
  })
  const bound: { host?: string; port?: number } = {}
  const network = (): Network => effectiveNetwork(config, settings)

  const unreadable = createUnreadableKeys({
    warn: (message) => logger.warn(message),
    record: (keys) =>
      audit.record({
        kind: 'settings.unreadable',
        actor: 'system',
        via: 'local',
        detail: { keys },
      }),
  })
  const providers = createProviderService({
    store: sealedProfileStore({
      inner: sqliteProfileStore(sqlite),
      vault,
      onUnreadable: unreadable.onUnreadable,
    }),
    unreadable,
    settings,
    cache: sqliteCatalogCache(sqlite),
    env: config.providerEnv,
    ...(options.definitions === undefined ? {} : { definitions: options.definitions }),
    catalogs: {
      ...(config.modelsDevUrl === undefined ? {} : { modelsDevUrl: config.modelsDevUrl }),
      ...options.catalogs,
    },
    warn: (message) => logger.warn(`providers: ${message}`),
  })
  await providers.ready()

  const instanceId = options.instanceId ?? instanceIdOf(config.dataDir)
  // a lease left by the previous run of this core is taken over at once (eharness hands the lock
  // recovery.instanceId as the owner of acquire; boot recovery needs it)
  const lock = sqliteLock(sqlite, { owner: instanceId })
  const timing = {
    ...DEFAULT_TIMING,
    ...(config.nodeTokenRotateMs === undefined
      ? {}
      : { nodeTokenRotateMs: config.nodeTokenRotateMs }),
    ...options.timing,
  }
  const messages = sqliteMessages(sqlite)
  const streams = sqliteStreamLog(sqlite, { retentionMs: STREAM_RETENTION_MS })
  // one inbox instance: the agents' storage and the context reset read its counts (`task-running`, ADR-0030 §3)
  const inbox = sqliteInbox(sqlite)
  const storage = {
    messages,
    state: sqliteState(sqlite),
    inbox,
    streams,
  }
  // every event of the feed goes through the amygdala's watch of `pending-changed`; a new wait carries
  // its id and expiry (ADR-0027 §10)
  const approvals = createApprovalSettings(settings)
  const store = watchPending(sqliteActivityStore(sqlite), (message) => logger.warn(message), {
    ttlMs: () => approvals.ttlMs(),
  })
  // an access change is a record on the person's own front session: the feed shows it to them only
  identity.onIdentityChanged(({ personId, reason }) =>
    emit(
      store,
      IDENTITY_CHANGED,
      frontSessionId(personId, generations.current(personId)),
      null,
      { personId, reason },
      (message) => logger.warn(message),
    ),
  )
  // presence of the people's clients, computed from their signals (docs/specs/parietal.md); its removal part is registered here
  const parietal = createParietal({
    generations,
    sqlite,
    store,
    people: identity.people,
    acl: identity.acl,
    audit: identity.aclAudit,
    removal: identity.removal,
    dataDir: config.dataDir,
    timing,
    warn: (message) => logger.warn(message),
  })
  const tasks = tasksRepo(sqlite)
  const unpriced = createUnpriced()
  const budget = createBudget({ sqlite, settings, store, unpriced, generations })
  // a removed person's dreaming folder is kept with the rest of their data and purged with it (ADR-0031 §8)
  identity.removal.registry.registerRemoval({
    module: 'dreaming',
    onPersonRemoved: dreamingRemoval({ dataDir: config.dataDir, repo: dreamingRepo(sqlite) }),
  })
  // the dreaming flush line (ADR-0031 §9): the person's mode from the dreaming table; the owner's default is `propose`
  const hardening = {
    budget,
    instanceId,
    dreamFlush: dreamFlushPlugin({
      repo: dreamingRepo(sqlite),
      owner: { isOwner: async (personId) => (await identity.people.owner())?.id === personId },
      // the member default is the `dreaming.memberDefault` setting (read at each flush)
      settings: () => dreamSettingsOf(settings),
    }),
  }
  // the delivery service of the plugins' wakes (docs/specs/delivery.md): its front route reads `holder.lead` lazily
  const holder: { lead?: HarnessAgent } = {}
  const delivery = createDeliveryService({
    sqlite,
    generations,
    logger,
    people: identity.people,
    audit,
    store,
    remainingUsd: (personId) => budget.statusOf(personId).remainingUsd,
    lead: () => holder.lead,
    lock,
    timing,
    parietal,
  })
  // an unpriced warning is logged and noted for `budget.get` (ADR-0027 §23)
  const harnessLogger = routeUnpriced(toHarnessLogger(logger), unpriced)
  const { version, sha } = await buildInfo(config.buildSha)
  const devices = deviceRequestsRepo(sqlite)
  const deviceLogin = createDeviceLogin({ devices, credentials, audit })
  const auditRetention = createAuditRetention({ repo: auditLog, settings, audit, via: 'local' })
  const health: Health = { status: 'ok', version, sha, boot: uuidv7() }

  // the activity logs (ADR-0032 §1): one queue and one settings reader for every agent; flushed when the core stops
  const activity = createActivityCapture({ sqlite, settings, logger })
  // the prefrontal region (docs/specs/prefrontal.md): the persona and the reply style; the first boot seeds the persona.
  // It is built before the rooms, whose notices read the persona's lines.
  const prefrontal = createPrefrontal({
    generations,
    sqlite,
    dataDir: config.dataDir,
    identity,
    store,
    warn: (message) => logger.warn(message),
  })
  prefrontal.persona.seed()
  // the shared-room region (docs/specs/corpus-callosum.md): the service, the RPC procedures and the removal part
  const rooms = createRooms({
    generations,
    sqlite,
    dataDir: config.dataDir,
    identity,
    settings,
    delivery,
    store,
    providers,
    storage,
    budget,
    lock,
    presence: parietal,
    warn: (message) => logger.warn(message),
    persona: prefrontal.persona,
    // the speaker's own address only (the reminder reads it per speaker)
    style: (personId) => prefrontal.styles.get({ by: personId, via: 'local', elevated: false }),
    // the speaker's clients (read only): the channel of the speaker sets the room's answer mode (P33.4.1)
    clients: (personId) => parietal.list(personId),
    ...(options.onRoomToolCall === undefined ? {} : { onToolCall: options.onRoomToolCall }),
    activityLogs: activity.plugin,
  })
  // the memory dreaming (docs/specs/dreaming.md): the run service, whose port the protocol engine holds; a mode change re-syncs
  // the person's `dream` built-in through `protocols` (bound below, read only when a mode changes)
  const dreaming = createDreaming({
    dataDir: config.dataDir,
    sqlite,
    settings,
    generations,
    identity,
    providers,
    budget,
    activityLogs: activity.plugin,
    delivery,
    store,
    syncDream: (personId, mode) => protocols.syncDream(personId, mode),
    warn: (message) => logger.warn(message),
  })
  const wiring: Wiring = {
    config,
    generations,
    inbox,
    ...(options.nodeCapabilities === undefined
      ? {}
      : { nodeCapabilities: options.nodeCapabilities }),
    rooms,
    prefrontal,
    logger,
    harnessLogger,
    sqlite,
    protocolCatalog: createProtocolCatalog({
      protocols: protocolsRepo(sqlite),
      warn: (message) => logger.warn(message),
    }),
    protocolsPort: delegatingProtocolsPort(),
    dreaming,
    identity,
    settings,
    providers,
    storage,
    store,
    tasks,
    budget,
    hardening,
    lock,
    version,
    health,
    network,
    bound,
    timing,
    plugins: options.plugins ?? BUILTIN_PLUGINS,
    activity,
    holder,
    delivery,
    parietal,
    // a guest principal resolves to an actor only while its session is live; the registry exists later
    guestRegistry: {},
    local,
    policies,
    devices,
    deviceLogin,
    auditRetention,
    ...(options.views === undefined ? {} : { views: options.views }),
    ...(options.guestHosts === undefined ? {} : { guestHosts: options.guestHosts }),
    ...(options.guestClock === undefined ? {} : { guestClock: options.guestClock }),
  }
  const front = await wireFront(wiring)
  const { pluginHost, care, cortex, agent, nodes } = front

  // workers that died with a previous process never ran their last hook: repair, report, and
  // bring the board in line (idempotent, so boot and a timer may both run it)
  const reconcile = createReconcile(care, agent, cortex, { tasks, store })
  // approvals older than `approvals.ttlHours` are denied as expired (ADR-0027 §10); boot and every reconcile tick
  const attentionDeps = {
    generations,
    lead: () => agent,
    cortex,
    tasks,
    people: identity.people,
    store,
    lock,
    capabilities: nodes.capabilities,
  }
  // the protocol engine (docs/specs/hypothalamus.md): reaches the nodes, the plugins, the delivery and the presence
  const protocols = await createProtocols({
    sqlite,
    generations,
    catalog: wiring.protocolCatalog,
    settings,
    store,
    tools: front.protocolTools,
    people: identity.people,
    identity,
    audit,
    parietal,
    delivery,
    budget,
    nodes: nodes.hub,
    plugins: pluginHost,
    approvals,
    attention: attentionOptions(attentionDeps),
    protocolsPort: wiring.protocolsPort,
    dreaming: dreaming.port,
    warn: (message) => logger.warn(message),
  })
  const expire = createApprovalExpiry({
    generations,
    // every person (the sweep picks the ones `recover` counts, so a suspended person's approvals still expire)
    people: () => identity.people.list(),
    peek: attentionOptions(attentionDeps).peek,
    open: (sessionId) => openQueueSession(attentionDeps, sessionId),
    approvals,
    store,
    audit,
    warn: (message) => logger.warn(message),
  })
  const prune = createPrune({
    logger,
    sqlite,
    audit,
    store,
    rooms: { sweep: () => rooms.service.sweep() },
    reviews: pluginHost.reviews,
    auditRetention,
    deviceLogin,
    removal: identity.removal,
    streams,
    pairing: pairingRepo(sqlite),
    retention: timing.retention,
    activityRetention: () => activity.settings.get(),
    // the dreaming files past their periods (archive 30 days, undo and staged 7 days; ADR-0031 §8)
    dreaming: {
      purge: () => purgeDreamFiles({ dataDir: config.dataDir, repo: dreamingRepo(sqlite), audit }),
    },
  })
  // a turn the previous process left half done is marked interrupted (with a notice) first, so
  // the reconcile and every reader see a settled session
  await care.recoverAll(agent)
  // the room sessions get the same repair, and a queued room message no answer followed runs once (P30.3.5)
  await rooms.recover(logger)
  await reconcile()
  await parietal
    .recomputeAll()
    .catch((error: unknown) =>
      logger.warn(`presence: ${error instanceof Error ? error.message : error}`),
    )
  await expire()
  await prune()
  // timers of plugins: a slot that came due while the core was down fires now (catch-up), then every tick
  await pluginHost.schedules.start()
  // deliveries left pending by a stopped core are retried now, then every `deliveryTickMs`
  delivery.start()
  // the protocol engine resumes its runs (a crash mid-step replays or ends `unknown`), then ticks every `protocols.tickMs`
  await protocols
    .recover()
    .catch((error: unknown) =>
      logger.warn(`protocols: recovery failed: ${error instanceof Error ? error.message : error}`),
    )
  const protocolTimer = createProtocolTimer({
    tickMs: () => protocols.tickMs(),
    beat: () => protocols.beat(),
    warn: (message) => logger.warn(message),
  })
  const timers = [
    setInterval(() => void reconcile(), timing.reconcileEveryMs),
    setInterval(() => void expire(), timing.reconcileEveryMs),
    setInterval(() => void prune(), timing.pruneEveryMs),
    setInterval(
      () =>
        void parietal
          .recomputeAll()
          .catch((error: unknown) =>
            logger.warn(`presence: ${error instanceof Error ? error.message : error}`),
          ),
      timing.presenceEveryMs,
    ),
  ]

  const edge = wireEdge(wiring, front, protocols.succession)
  const { viewParts, guests } = edge

  return {
    acl: identity.acl,
    kinds: identity.kinds,
    plugins: pluginHost,
    views: viewParts.views,
    viewSockets: () => viewParts.gateway.connections(),
    guests: guests.registry,
    guestHttp: edge.guestHttp,
    guestAudit: guests.audit,
    fetch: edge.fetch,
    fetchLocal: edge.fetchLocal,
    network,
    announce(address) {
      bound.host = address.host
      bound.port = address.port
    },
    websocket: edge.websocket,
    health,
    activity: { flush: () => activity.flush() },
    async close() {
      for (const timer of timers) clearInterval(timer)
      // a tick in flight finishes its step first (graceful stop: no step is cut in half)
      await protocolTimer.stop()
      identity.streams.close()
      viewParts.gateway.close()
      viewParts.views.closeAll('error')
      nodes.close()
      // a graceful stop interrupts each turn in flight like a recovered crash (/continue works)
      await pluginHost.schedules.stop()
      delivery.stop()
      await guests.registry.close()
      guests.audit.close()
      await care.closeAgent(agent)
      // the room turns in flight are interrupted like the front turns; a queued room message stays for the next boot
      await rooms.close(logger)
      await cortex.close()
      await pluginHost.close()
      providers.manager.dispose()
      // a hook of a turn that just ended may still be writing (reports retry in the background)
      await new Promise<void>((resolve) => setTimeout(resolve, 60))
      // the calls queued by the last turns reach the database before it closes
      await activity.stop()
      sqlite.close()
    },
  }
}
