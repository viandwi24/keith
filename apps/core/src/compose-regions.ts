import type { Health, NodeCapabilitySpec, PersonStatus } from '@keith/contracts'
import {
  agendaRepo,
  type deviceRequestsRepo,
  frontGenerationsRepo,
  protocolProposalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  roomsRepo,
  type settingsRepo,
  type sqliteLock,
  type tasksRepo,
} from '@keith/db'
import type { KeithPlugin } from '@keith/host'
import type { Server } from 'bun'
import type { HarnessAgent, InboxAdapter } from 'eharness'
import type { ActivityCapture } from './compose-activity.ts'
import { createConsentPort } from './compose-consent.ts'
import type { DreamingRegion } from './compose-dreaming.ts'
import { createGuestFetch, createGuests } from './compose-guests.ts'
import type { createIdentity } from './compose-identity.ts'
import { wireNodes } from './compose-nodes.ts'
import { createPlugins } from './compose-plugins.ts'
import type { PrefrontalRegion } from './compose-prefrontal.ts'
import type { RoomsRegion } from './compose-rooms.ts'
import { createSessionCare } from './compose-sessions.ts'
import type { CoreTiming } from './compose-timers.ts'
import {
  createViews,
  dispatchSockets,
  type SocketData,
  VIEW_SOCKET_PATH,
  type ViewLimitsForTests,
} from './compose-views.ts'
import { wireWorkspace } from './compose-workspace.ts'
import { createAclActors } from './modules/acl/actors.ts'
import { adminProcedures, type Network } from './modules/admin/index.ts'
import {
  attentionOptions,
  type ClientAuth,
  type Consent,
  type ConsentNotes,
  createApprovalSettings,
  createClientAuth,
  createConsent,
  createConsentNotes,
  createUndoPlugin,
  type watchPending,
} from './modules/amygdala/index.ts'
import { activityLogsProcedures } from './modules/audit/activity-logs/procedures.ts'
import { activityLogsRemoval } from './modules/audit/activity-logs/removal.ts'
import { createLogRights } from './modules/audit/activity-logs/rights.ts'
import type { createAuditRetention } from './modules/audit/index.ts'
import {
  createAuthRoutes,
  type createDeviceLogin,
  createLanNets,
  type createLocalAccess,
  type createPolicyStore,
  createPrincipalResolver,
  type Via,
} from './modules/auth/index.ts'
import { budgetProcedures, type createBudget } from './modules/budget/index.ts'
import { createRoomPostPlugin } from './modules/corpus-callosum/index.ts'
import { createCortex } from './modules/cortex/index.ts'
import type { Delivery } from './modules/delivery/index.ts'
import type { GuestRegistry } from './modules/guests/index.ts'
import {
  agendaProcedures,
  createAgendaService,
  createProposalService,
  createProtocolHostPort,
  createProtocolService,
  createProtocolSettings,
  type DelegatingProtocolsPort,
  hypothalamusRemoval,
  type ProtocolCatalogHandle,
  type ProtocolToolSlot,
  protocolProcedures,
  protocolToolSlot,
  type SuccessionService,
  successionProcedures,
} from './modules/hypothalamus/index.ts'
import {
  createNodeCallLimit,
  createNodeCallLimitSettings,
  motorConsentEffect,
  ownerAnswers,
} from './modules/motor/index.ts'
import { type createNodes, type NodeSocketData, nodeProcedures } from './modules/nodes/index.ts'
import {
  type CatalogApp,
  clientCallConsentEffect,
  clientCallTool,
  clientContextFor,
  type ParietalService,
  presenceProcedures,
  presenceTool,
  type WorkspaceService,
  workspaceConsentEffect,
  workspaceProcedures,
} from './modules/parietal/index.ts'
import { coreRemoval } from './modules/people/index.ts'
import { createPluginRoutes, createWake } from './modules/plugins/index.ts'
import {
  createOnboarding,
  createPersonaToolsPlugin,
  guestUnavailableLine,
} from './modules/prefrontal/index.ts'
import {
  createModelToolsPlugin,
  type createProviderService,
  providerProcedures,
} from './modules/providers/index.ts'
import { type PushService, pushProcedures } from './modules/push/index.ts'
import { announceFinished, taskProcedures } from './modules/tasks/index.ts'
import { createApp, createRequestGuard, isForwarded } from './modules/thalamus/index.ts'
import {
  type ContextService,
  chatProcedures,
  createContextService,
  createFrontAgent,
  type FrontGenerations,
  type WhoIs,
  wernickeBrocaRemoval,
} from './modules/wernicke-broca/index.ts'
import type { Config } from './platform/config.ts'
import type { Logger, toHarnessLogger } from './platform/logger.ts'
import type { NetProxy } from './platform/net-proxy.ts'
import type { pruneRetention } from './platform/retention.ts'
import { rpc } from './platform/rpc.ts'
import { frontSessionId } from './platform/sessions.ts'
import { createUndoLog } from './platform/undo-log.ts'

type Identity = ReturnType<typeof createIdentity>
type Store = ReturnType<typeof watchPending>
type Budget = ReturnType<typeof createBudget>
type Storage = Parameters<typeof createCortex>[0]['storage']

/** What compose.ts builds first and every region is wired from (the core's shared machinery). */
export interface Wiring {
  config: Config
  /** The current front generation of each person (ADR-0030 §2): every front session id is built from it. */
  generations: FrontGenerations
  /** The sqlite inbox of the agents (the same instance as `storage.inbox`): the context reset counts its items. */
  inbox: InboxAdapter
  /** Extra node capability specs, on top of the built-in ones (`CoreOptions.nodeCapabilities`). */
  nodeCapabilities?: readonly NodeCapabilitySpec[]
  logger: Logger
  harnessLogger: ReturnType<typeof toHarnessLogger>
  sqlite: Parameters<typeof pruneRetention>[0]
  identity: Identity
  settings: ReturnType<typeof settingsRepo>
  providers: ReturnType<typeof createProviderService>
  storage: Storage
  store: Store
  tasks: ReturnType<typeof tasksRepo>
  budget: Budget
  hardening: { budget: Budget; instanceId: string }
  lock: ReturnType<typeof sqliteLock>
  version: string
  health: Health
  net: NetProxy
  network: () => Network
  /** The bound address, once the listener announces it (`Core.announce`). */
  bound: { host?: string; port?: number }
  timing: CoreTiming
  plugins: readonly KeithPlugin[]
  /** The activity-log capture: its `activity-logs` plugin goes to every agent (ADR-0032 §1). */
  activity: ActivityCapture
  /** The lead agent, set once the front region is wired. */
  holder: { lead?: HarnessAgent }
  /** The cached set of enabled protocols (`modules/hypothalamus/catalog.ts`), shared by the service and the engine. */
  protocolCatalog: ProtocolCatalogHandle
  /** The protocol port of plugins (`k.protocols`): forwards to the service, bound in `wireEdge`. */
  protocolsPort: DelegatingProtocolsPort
  /** The delivery service (`compose-delivery.ts`): plugins wake people through it. */
  delivery: Delivery
  /** The parietal region: clients and presence (`compose-parietal.ts`). */
  parietal: ParietalService
  /** Web Push: subscriptions and the `push.preview` setting (`compose-push.ts`). */
  push: PushService
  /** The shared-room region: the service and its RPC procedures (`compose-rooms.ts`). */
  rooms: RoomsRegion
  /** The memory dreaming: the run service and the `dream` procedures (`hippocampus/dream`, compose-dreaming.ts). */
  dreaming: DreamingRegion
  /** The prefrontal region: the persona and the reply style, with their RPC procedures (`compose-prefrontal.ts`). */
  prefrontal: PrefrontalRegion
  /** The guest registry, set once the guest region is wired (the plugins ask it for live guests). */
  guestRegistry: { current?: GuestRegistry }
  local: ReturnType<typeof createLocalAccess>
  policies: ReturnType<typeof createPolicyStore>
  devices: ReturnType<typeof deviceRequestsRepo>
  deviceLogin: ReturnType<typeof createDeviceLogin>
  auditRetention: ReturnType<typeof createAuditRetention>
  /** Test only: the limits of plugin terminal views and the audit/open windows. */
  views?: ViewLimitsForTests
  /** Test only: the machine names the guest listener's Host guard accepts. */
  guestHosts?: () => readonly string[]
  /** Test only: the clock of guest sessions and of the per-address start window. */
  guestClock?: () => number
}

/** The front region: nodes, plugins, per-person care, the cortex (workers) and the front agent. */
export interface Front {
  workspace: WorkspaceService
  /** The window apps of this core (`web.window` contributions, ADR-0038). */
  workspaceApps: () => readonly CatalogApp[]
  nodes: ReturnType<typeof createNodes>
  pluginHost: Awaited<ReturnType<typeof createPlugins>>
  care: ReturnType<typeof createSessionCare>
  cortex: ReturnType<typeof createCortex>
  agent: HarnessAgent
  /** The protocol tools of the front agent; the services are bound in `wireEdge`, the engine in `compose-protocols.ts`. */
  protocolTools: ProtocolToolSlot
  /** The context reset and compaction (docs/specs/chat-context.md): the service the `chat.*` procedures call. */
  context: ContextService
  /** Conversational consent (ADR-0036): the hooks of the front agent and the workers; the attention list reads its registry. */
  consent: Consent
  /** The notes of the person's answers to a worker's request, read by the front agent (`consent-note.ts`). */
  consentNotes: ConsentNotes
  /** The step-up of the client each person last wrote from: the consent hook reads it for the persona and model tools. */
  clientAuth: ClientAuth
}

export async function wireFront(w: Wiring): Promise<Front> {
  const { config, logger, sqlite, identity, store, timing, holder, tasks, storage } = w
  const { audit, people } = identity
  // the nodes hub: pairing, heartbeats, drivers and their audit rows (docs/specs/nodes.md)
  const nodes = wireNodes(w)
  // plugins: boot each one in isolation; a failure is logged and marked, never thrown
  // a guest principal resolves to an actor only while its session is live (`guestRegistry`); the registry exists later
  const pluginHost = await createPlugins({
    plugins: w.plugins,
    guestLive: (id) => w.guestRegistry.current?.get(id) !== undefined,
    sqlite,
    people,
    capabilities: identity.capabilities,
    registry: identity.capabilityRegistry,
    acl: identity.acl,
    kinds: identity.kinds,
    audit,
    settings: w.settings,
    logger,
    store,
    access: identity.access,
    aclAudit: identity.aclAudit,
    wake: createWake({ delivery: w.delivery }),
    protocols: w.protocolsPort.port,
    schedules: { tickMs: timing.scheduleTickMs },
    pluginConfig: config.pluginConfig,
  })
  // per-person care of the front sessions: dead letters, recovery, reconcile, graceful stop
  const care = createSessionCare({
    people,
    lock: w.lock,
    logger,
    lead: () => holder.lead,
    generations: w.generations,
  })
  const onDeadLetter = care.onDeadLetter
  const whois: WhoIs = async (id) => {
    const p = await people.get(id).catch(() => undefined)
    return p === undefined ? undefined : { name: p.name, username: p.username, role: p.role }
  }
  const lead = (): HarnessAgent => holder.lead as HarnessAgent
  // conversational consent (ADR-0036): one registry for the front agent and its workers (a worker is clean only when the front
  // call that delegated it was), and one undo log for the reversible tools
  const clientAuth = createClientAuth()
  const motorEffect = motorConsentEffect(nodes.capabilities)
  const consent = createConsent({
    effectOf: (name, input) =>
      motorEffect(name, input) ??
      workspaceConsentEffect(name, input) ??
      clientCallConsentEffect(name, input),
    elevatedOf: clientAuth.elevatedOf,
    stepUpCall: (toolName, input) => ownerAnswers(toolName, input, nodes.capabilities),
  })
  const undo = createUndoLog()
  const consentNotes = createConsentNotes()
  const cortex = createCortex({
    consent: consent.plugin('worker'),
    providers: w.providers,
    storage,
    store,
    tasks,
    logger: w.harnessLogger,
    lead,
    nodes: nodes.hub,
    capabilities: nodes.capabilities,
    callsPerHour: createNodeCallLimit(w.settings),
    audit: identity.audit,
    isRoomMember: (roomId, person) => roomsRepo(sqlite).member(roomId, person)?.status === 'active',
    dataDir: config.dataDir,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    inboxPollMs: timing.inboxPollMs,
    onDeadLetter,
    nameOf: async (id) => (await whois(id))?.name,
    hardening: w.hardening,
    activityLogs: w.activity.plugin,
    observeAux: w.activity.observeAux,
  })
  const protocolTools = protocolToolSlot(createAclActors({ people }))
  // the person's own workspace (docs/specs/workspace.md): one service for the RPC router and Keith's `workspace` tool
  const workspace = wireWorkspace({
    ...w,
    store,
    actors: createAclActors({ people }),
    audit,
    undo,
    contributions: (point) => pluginHost.contributions(point),
    can: async (personId, capability) => {
      const person = await people.get(personId).catch(() => undefined)
      return (
        person !== undefined &&
        identity.capabilities.of({ personId, role: person.role }).has(capability)
      )
    },
  })
  const agent = createFrontAgent({
    whois,
    // the persona (system prompt block) and the style of the turn's person (turn reminder), docs/specs/prefrontal.md
    persona: w.prefrontal.persona,
    style: (personId) => w.prefrontal.styles.get({ by: personId, via: 'local', elevated: false }),
    // onboarding while the person has no style row, and the persona and style tools (ADR-0034 §3, §4)
    onboarding: createOnboarding({ styles: w.prefrontal.styles, people }),
    personaTools: createPersonaToolsPlugin({
      persona: w.prefrontal.persona,
      styles: w.prefrontal.styles,
      undo,
    }),
    undoTool: createUndoPlugin(undo),
    consent: consent.plugin('front'),
    // the owner's model tools: read the role picks, switch one after approval (ADR-0034 §8)
    modelTools: createModelToolsPlugin({
      providers: w.providers,
      audit: identity.audit,
      isOwner: async (personId) => (await whois(personId))?.role === 'owner',
      undo,
    }),
    // the person's clients (read only): their channel and second screen choose the answer mode (P33.4.1)
    clients: (personId) => w.parietal.list(personId),
    // the client in use of the person (host, OS, device, network, local time), docs/decisions/0033 §5
    clientContext: (personId) => clientContextFor(w.parietal, personId),
    providers: w.providers,
    storage,
    logger: w.harnessLogger,
    inboxPollMs: timing.inboxPollMs,
    onDeadLetter,
    hardening: { ...w.hardening, dataDir: config.dataDir },
    delegation: { cortex, tasks, store, self: lead, nodes: nodes.hub },
    plugins: [...pluginHost.harnessPlugins(), consentNotes.plugin],
    presence: presenceTool({
      parietal: w.parietal,
      people,
      actors: createAclActors({ people }),
      audit,
      undo,
    }),
    // `client_call` (P31.5.3): the person's own clients only, through the one route `callClient`
    clientCall: clientCallTool({
      parietal: w.parietal,
      actors: createAclActors({ people }),
      audit,
    }),
    // `workspace` (P40.3): Keith changes the person's workspace and asks their screen to show it (docs/specs/workspace.md "Keith")
    workspaceTool: workspace.tool,
    onScreen: workspace.onScreen,
    protocolTools: protocolTools.plugin,
    // `room_post` (P30.4.3): offered only while the person is active in a room; it never posts by itself
    roomPost: createRoomPostPlugin({ rooms: roomsRepo(sqlite), service: w.rooms.service }),
    activityLogs: w.activity.plugin,
    // `document_save` (P33.4.3): the personal session only; writes the person's own documents folder
    dataDir: config.dataDir,
  })
  holder.lead = agent
  const context = createContextService({
    lead,
    lock: w.lock,
    inbox: w.inbox,
    tasks,
    generations: w.generations,
    audit,
    store,
    warn: (message) => logger.warn(message),
  })
  return {
    nodes,
    pluginHost,
    care,
    cortex,
    agent,
    protocolTools,
    context,
    consent,
    clientAuth,
    consentNotes,
    workspace: workspace.service,
    workspaceApps: workspace.catalog,
  }
}

/** The HTTP edge: guests, plugin views, the core-tables removal, the RPC router, the Hono app and the entry points. */
export function wireEdge(w: Wiring, front: Front, succession: SuccessionService) {
  const { config, logger, sqlite, identity, store, lock, network, bound, holder, budget, tasks } = w
  const { nodes, pluginHost, cortex, agent, context } = front
  const { audit, people, tokens, credentials, secrets, hasher, auditLog } = identity
  const { local, policies, devices, deviceLogin, auditRetention } = w
  const lead = (): HarnessAgent => holder.lead as HarnessAgent
  const guests = createGuests({
    sqlite,
    settings: w.settings,
    providers: w.providers,
    budget,
    publicUrl: () => network().publicUrl,
    logger: w.harnessLogger,
    audit,
    store,
    plugins: pluginHost.harnessPlugins(),
    activityLogs: w.activity.plugin,
    timing: { sweepEveryMs: w.timing.guestSweepEveryMs, graceMs: w.timing.guestGraceMs },
    ...(w.guestClock === undefined ? {} : { now: w.guestClock }),
  })
  w.guestRegistry.current = guests.registry
  const guard = createRequestGuard({
    publicUrl: () => network().publicUrl,
    extraHosts: config.allowedHosts,
  })

  // plugin terminal views: the socket gateway and the view host (docs/specs/plugin-views.md)
  const viewParts = createViews({
    host: pluginHost,
    principals: createPrincipalResolver(tokens, credentials, {
      localImplicit: () => local.implicit(),
    }),
    local,
    audit,
    logger,
    activity: store,
    ...(w.views === undefined ? {} : { tuning: w.views }),
  })
  // the core's own rows of a removed person: their running workers stop first (people/removal-core.ts)
  identity.removal.registry.registerRemoval({
    module: 'core-tables',
    onPersonRemoved: coreRemoval({
      sqlite,
      dataDir: config.dataDir,
      heirOf: async () => (await people.owner())?.id,
      stopWorker: async (task) => {
        const worker = cortex.worker(task.agent)
        if (worker !== undefined) await worker.session(task.id).abort('stopped')
      },
    }),
  })
  // the context reset's part of a removed person (ADR-0030 §11): the generation rows are kept, then purged
  identity.removal.registry.registerRemoval({
    module: 'wernicke-broca',
    onPersonRemoved: wernickeBrocaRemoval({
      generations: frontGenerationsRepo(sqlite),
      map: w.generations,
    }),
  })
  // the protocol engine's settings (hypothalamus.md "Settings"): read at each use, bounds from @keith/contracts
  const protocolSettings = createProtocolSettings(w.settings)
  // the protocol records (hypothalamus.md "Service") and their part of a removed person (ADR-0027 §26); every write
  // that moves an enabled protocol refreshes the cached set the triggers read (`protocolCatalog`, compose.ts)
  const protocolService = createProtocolService({
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    settings: protocolSettings,
    audit,
    ownerAccess: identity.aclAudit,
    catalog: w.protocolCatalog,
  })
  // the plugins' `k.protocols` reach this service (host-port.ts): bound once, read at each call
  w.protocolsPort.bind(
    createProtocolHostPort({
      service: protocolService,
      protocols: protocolsRepo(sqlite),
      runs: protocolRunsRepo(sqlite),
      now: () => Date.now(),
    }),
  )
  identity.removal.registry.registerRemoval({
    module: 'hypothalamus',
    onPersonRemoved: hypothalamusRemoval({
      sqlite,
      dataDir: config.dataDir,
      onChange: () => w.protocolCatalog.changed(),
    }),
  })
  // the activity logs of a removed person (ADR-0032 §7): kept in place, exported, purged with the kept folder
  identity.removal.registry.registerRemoval({
    module: 'activity-logs',
    onPersonRemoved: activityLogsRemoval({ sqlite, audit }),
  })
  const protocolProposals = createProposalService({
    proposals: protocolProposalsRepo(sqlite),
    service: protocolService,
    audit,
  })
  // the personal agenda (hypothalamus.md "Agenda"): the items, the meeting proposals, and the agent tools' writes
  const agendaService = createAgendaService({
    agenda: agendaRepo(sqlite),
    proposalRows: protocolProposalsRepo(sqlite),
    proposals: protocolProposals,
    ownerAccess: identity.aclAudit,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  front.protocolTools.bind({
    service: protocolService,
    proposals: protocolProposals,
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    agenda: agendaService,
  })
  // the activity logs' rights (ADR-0032 §8): room membership and a person's status are read per call, so a removal takes effect at once
  const personStatusOf = (personId: string): PersonStatus | undefined => {
    const row = sqlite
      .query<{ status: string }, [string]>('SELECT status FROM people WHERE id = ?')
      .get(personId)
    return row === null ? undefined : row.status === 'active' ? 'active' : 'suspended'
  }
  const logRooms = roomsRepo(sqlite)
  const logRights = createLogRights({
    rooms: {
      canRead: (personId, roomId) => logRooms.member(roomId, personId)?.status === 'active',
      activeMembers: (roomId) =>
        logRooms
          .members(roomId)
          .filter((m) => m.status === 'active')
          .map((m) => m.personId),
    },
    people: { statusOf: personStatusOf },
    audit,
    aclAudit: identity.aclAudit,
  })
  const router = rpc.router({
    budget: budgetProcedures(budget, people),
    // the network of a client is derived from the listener and the peer, with the same LAN subnets and proxy setting as the login
    presence: {
      ...presenceProcedures(w.parietal, {
        lan: () => lanNets,
        proxy: () => network().proxy,
      }),
      push: pushProcedures(w.push),
    },
    protocols: protocolProcedures({
      settings: protocolSettings,
      service: protocolService,
      proposals: protocolProposals,
      runs: protocolRunsRepo(sqlite),
      // bound to the engine when the protocol wiring runs (compose-protocols.ts); a call before that is an internal error
      answer: (input) => front.protocolTools.answer(input),
    }),
    agenda: agendaProcedures({ agenda: agendaService }),
    rooms: w.rooms.procedures,
    persona: w.prefrontal.procedures,
    // the person's own workspace (docs/specs/workspace.md "RPC"); a change is announced on their own front session
    workspace: workspaceProcedures(front.workspace, front.workspaceApps),
    // the context reset and compaction (docs/specs/chat-context.md "RPC"): the caller's own front session only
    chat: chatProcedures({ context }),
    // the memory dreaming (docs/specs/dreaming.md "RPC"): the caller's own memory, the owner's audited diary read and settings
    dream: w.dreaming.procedures,
    // the activity logs (docs/specs/activity-logs.md "RPC"): every read asks the rights first
    logs: activityLogsProcedures({
      repo: w.activity.repo,
      rights: logRights,
      settings: w.activity.settings,
      queue: w.activity.queue,
      statusOf: personStatusOf,
      roomIdsOf: (personId) =>
        logRooms
          .roomsOf(personId, 500)
          .filter((r) => r.member.status === 'active')
          .map((r) => r.room.id),
    }),
    nodes: nodeProcedures({
      registry: nodes.hub,
      pairing: nodes.pairing,
      callLimit: createNodeCallLimitSettings(w.settings),
    }),
    ...adminProcedures({
      config,
      settings: w.settings,
      tokens,
      credentials,
      devices,
      deviceLogin,
      audit: auditLog,
      people,
      parietal: w.parietal,
      delivery: w.delivery,
      peopleSecrets: identity.peopleSecrets,
      grants: identity.grants,
      groups: identity.groups,
      succession: successionProcedures({ service: succession }),
      guests: guests.admin,
      reviews: pluginHost.reviews,
      plugins: pluginHost.admin,
      views: viewParts.views,
      capabilityRegistry: identity.capabilityRegistry,
      access: identity.access,
      auditRetention,
      aliases: identity.aliases,
      exporter: identity.exporter,
      policies,
      local,
      secretKinds: (personId) => secrets.kinds(personId),
      bound: () => bound,
    }),
    health: { get: rpc.health.get.handler(() => w.health) },
    ...providerProcedures(w.providers),
    tasks: taskProcedures({
      tasks,
      sessionOf: (principal) =>
        frontSessionId(principal.personId, w.generations.current(principal.personId)),
      onStopped: (task) => announceFinished(store, task),
      stop: async (task) => {
        const worker = cortex.worker(task.agent)
        if (worker === undefined) return
        await worker.session(task.id).abort('stopped')
        // a worker parked on an approval has no turn to abort: its approval is denied instead
        // (ADR-0027 §11), so the command never reaches a node
        await cortex
          .cancelPending(task.id, task.agent, 'the task was stopped')
          .catch((error: unknown) =>
            logger.warn(
              `tasks: cancelling the approvals of ${task.id} failed: ${error instanceof Error ? error.message : error}`,
            ),
          )
      },
    }),
  })
  // on-link subnets of this machine for the `lan` zone (docs/specs/auth.md); refreshed each minute
  const lanNets = createLanNets({ extra: () => policies.get().lanCidrs })
  const guestHttp = createGuestFetch({
    guests,
    lan: () => lanNets,
    publicUrl: () => network().publicUrl,
    // a visitor's failed turn reads the persona's guest line (docs/specs/guests.md, prefrontal.md "Fixed lines")
    guestLine: () => guestUnavailableLine(w.prefrontal.persona),
    ...(w.guestHosts === undefined ? {} : { ownNames: w.guestHosts }),
    ...(w.guestClock === undefined ? {} : { now: w.guestClock }),
    // the guest chat page of the web build, on the guest listener (`/app/guest`)
    ...(config.web ? { web: { dir: config.webDir } } : {}),
  })
  const attention = attentionOptions({
    generations: w.generations,
    lead,
    cortex,
    tasks,
    people,
    store,
    lock,
    approvals: createApprovalSettings(w.settings),
    capabilities: nodes.capabilities,
    consent: front.consent.registry,
    conversationTtlMs: () => w.timing.conversationTtlMs,
  })
  const app = createApp({
    generations: w.generations,
    // the static bundles of plugin window apps, with a CSP per app (ADR-0038 §5, docs/specs/thalamus.md "Plugin web bundles")
    pluginWeb: {
      plugins: () => pluginHost.loaded(),
      contributions: (point) => pluginHost.contributions(point),
      net: w.net,
    },
    agent,
    tokens,
    credentials,
    audit,
    ...(config.web ? { web: { dir: config.webDir } } : {}),
    capabilities: identity.capabilities,
    streams: identity.streams,
    local,
    device: deviceLogin,
    auth: createAuthRoutes({
      secrets,
      credentials,
      tokens,
      hasher,
      audit,
      proxy: () => network().proxy,
      insecure: config.insecureLogin,
      identifiers: identity.identifiers,
      policy: policies.get,
      lan: () => lanNets,
    }),
    router,
    plugins: createPluginRoutes({ host: pluginHost }),
    health: () => w.health,
    lock,
    activity: { store, bootId: w.health.boot, warn: (message) => logger.warn(message) },
    attention,
    consent: createConsentPort({
      attention,
      consent: front.consent,
      clients: front.clientAuth,
      generations: w.generations,
      store,
      audit,
      providers: w.providers,
      observe: (name, personId, model) => w.activity.observeAux(name, personId, model),
      ttlMs: () => w.timing.conversationTtlMs,
      logger,
      agent: lead(),
      lock,
      notes: front.consentNotes,
    }),
    join: (request, clientKey) => nodes.pairing.join(request, clientKey),
    onRouted: (personId) => w.parietal.recordActivity(personId),
  })

  const handle = (
    request: Request,
    server: Pick<Server<unknown>, 'requestIP' | 'timeout'> | undefined,
    via: Via,
    forwarded = false,
    funnel = false,
  ) => {
    // the peer address only: forwarding headers are never trusted for it
    const ip = via === 'local' ? 'local' : server?.requestIP(request)?.address
    // an authorized request lifts the idle timeout (streams stay open); pre-auth ones keep it
    const keepAlive = server === undefined ? undefined : () => server.timeout(request, 0)
    return app.fetch(request, {
      via,
      forwarded,
      funnel,
      ...(ip === undefined ? {} : { ip }),
      ...(keepAlive === undefined ? {} : { keepAlive }),
    })
  }

  return {
    guests,
    guestHttp,
    viewParts,
    websocket: dispatchSockets(nodes.gateway.websocket, viewParts.gateway.websocket),
    async fetch(request: Request, server?: Server<SocketData>) {
      // every TCP request, the node WebSocket upgrade included: Host and Origin first
      const refused = guard.check(request, server?.port ?? bound.port)
      if (refused !== undefined) return refused
      if (new URL(request.url).pathname === '/nodes/ws') {
        if (server === undefined)
          return new Response('a WebSocket server is required', { status: 426 })
        return nodes.gateway.upgrade(request, server as Server<NodeSocketData>)
      }
      if (new URL(request.url).pathname === VIEW_SOCKET_PATH) {
        if (server === undefined)
          return new Response('a WebSocket server is required', { status: 426 })
        return viewParts.gateway.upgrade(request, server)
      }
      return handle(
        request,
        server,
        'tcp',
        isForwarded(request.headers),
        request.headers.has('tailscale-funnel-request'),
      )
    },
    async fetchLocal(request: Request, server?: Server<undefined>) {
      // plugin views over the local socket: the lock (423) and the trust (a bearer when `none`) are the HTTP rules
      if (new URL(request.url).pathname === VIEW_SOCKET_PATH) {
        if (server === undefined)
          return new Response('a WebSocket server is required', { status: 426 })
        if (local.mode() === 'locked')
          return Response.json(
            { error: 'locked', code: 'LOCKED', status: 423, message: 'the local socket is locked' },
            { status: 423 },
          )
        return viewParts.gateway.upgrade(request, server, 'local')
      }
      return (await handle(request, server, 'local')) ?? new Response(null, { status: 404 })
    },
  }
}
