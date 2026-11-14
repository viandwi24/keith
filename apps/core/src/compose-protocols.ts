// The protocol engine wired into the core (docs/specs/hypothalamus.md, "Engine", "Triggers", "Restart"): the real adapters
// of the engine's ports, the engine, the triggers, boot recovery and the tick the timer calls (compose-timers.ts). compose.ts
// calls it once, after the front region (the nodes and the plugins the `act` step reaches) and the delivery service.

import { type DreamMode, MS_HOUR } from '@keith/contracts'
import {
  agendaRepo,
  dreamingRepo,
  presenceSignalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  type SettingsRepo,
  type Sqlite,
  sqliteSchedules,
  successionRepo,
} from '@keith/db'
import { GuardError, type KeithPlugin } from '@keith/host'
import { type ActivityStore, listAttention } from 'eharness/activity'
import type { createIdentity } from './compose-identity.ts'
import type { ApprovalSettings, AttentionOptions } from './modules/amygdala/index.ts'
import type { Delivery } from './modules/delivery/index.ts'
import type { DelegatingProtocolsPort } from './modules/hypothalamus/index.ts'
import {
  type ActPorts,
  agendaOverlay,
  createAct,
  createDreamSteps,
  createEngine,
  createJournal,
  createProtocolSettings,
  createRunStarter,
  createSignOfLife,
  createStepRunner,
  createSuccession,
  createSuccessionSteps,
  createTriggers,
  DREAMING_RUN,
  type DreamingRunPort,
  dreamSettingsOf,
  effectiveDreamMode,
  type FlatDetail,
  type Journal,
  type ProtocolCatalogHandle,
  type ProtocolEngine,
  type ProtocolToolSlot,
  type StepResult,
  type StepRunInput,
  type SuccessionDeps,
  type SuccessionService,
  seedBuiltIns,
  settingsCursorStore,
  syncDream,
  syncOwnerAbsence,
  type Triggers,
} from './modules/hypothalamus/index.ts'
import { LAST_SIGN_TYPES, type ParietalService } from './modules/parietal/index.ts'
import type { PluginHost } from './modules/plugins/index.ts'
import {
  countsFor,
  type FrontGenerationOf,
  frontSessionId,
  peopleFor,
} from './platform/sessions.ts'

type Identity = ReturnType<typeof createIdentity>

export interface ProtocolsWiring {
  sqlite: Sqlite
  /** The current front generation of each person (ADR-0030 §2): the session of every front call. */
  generations: FrontGenerationOf
  settings: SettingsRepo
  /** The front agent's protocol tools: bound to the engine and the repos here (`hypothalamus/tools.ts`). */
  tools: ProtocolToolSlot
  /** The activity feed (the event trigger reads it; the approval guard reads the attention queue). */
  store: ActivityStore
  people: Pick<Identity['people'], 'list' | 'get' | 'owner' | 'requireOwner' | 'succeed'>
  /** The identity changes (an heir who is suspended or removed is cleared) and the secrets (an heir needs one, F-013). */
  identity: Pick<Identity, 'onIdentityChanged' | 'secrets'>
  /** The cached set of enabled protocols; the protocol service refreshes it on every change (`catalog.ts`). */
  catalog: ProtocolCatalogHandle
  /** The audit log: the runs' rows (`protocol.run.*`, `protocol.act`), actor `system`. */
  audit: Pick<Identity['audit'], 'record'>
  parietal: Pick<ParietalService, 'lastSign' | 'disclosedFor' | 'presence' | 'addOverlay'>
  delivery: Pick<Delivery, 'deliver'>
  budget: { statusOf(personId: string): { remainingUsd: number | null } }
  nodes: ActPorts['nodes']
  plugins: PluginHost
  approvals: Pick<ApprovalSettings, 'ttlMs' | 'pingBeforeHours'>
  attention: Pick<AttentionOptions, 'peek'>
  /** The plugins' protocol port: a plugin's timed protocol that ends is reported to the plugin (`runEnded`). */
  protocolsPort: Pick<DelegatingProtocolsPort, 'runEnded'>
  warn: (message: string) => void
  /** The dreaming run service behind the `dreaming.run` step (`hippocampus/dream/service.ts`); absent, the step is not wired. */
  dreaming?: DreamingRunPort
}

/** The `system` port: `dreaming.run` goes to the dreaming steps, every other action to the succession steps (P29.2.4). */
function systemSteps(
  succession: (input: StepRunInput) => Promise<StepResult>,
  dreaming: DreamingRunPort | undefined,
): (input: StepRunInput) => Promise<StepResult> {
  const dream = dreaming === undefined ? undefined : createDreamSteps(dreaming)
  return (input) => {
    if (input.step.kind !== 'system' || input.step.action !== DREAMING_RUN) return succession(input)
    return dream === undefined
      ? Promise.resolve({ kind: 'done', outcome: 'failed:not-wired' })
      : dream(input)
  }
}

export interface Protocols {
  readonly engine: ProtocolEngine
  readonly triggers: Triggers
  /** The owner-absence settings: the heir, the window and the pause (docs/specs/succession.md). */
  readonly succession: SuccessionService
  /** The engine tick in ms, read at each call (`protocols.tickMs`). */
  tickMs(): number
  /**
   * The person's `dream` built-in follows the dreaming mode (ADR-0031 §6). Called at boot for every person and by the dream
   * service when `dream.mode` changes; `mode` defaults to the effective mode (stored, else the owner or member default).
   */
  syncDream(personId: string, mode?: DreamMode): Promise<void>
  /** Boot recovery (`engine.recover`), once, before the timer starts. */
  recover(): Promise<void>
  /** One tick: the triggers (time, absence, signal, event), then the due runs and the `cancelWhen` checks. */
  beat(): Promise<void>
}

/** The plugin operation the `act` step calls as the owner: the plugin host's guard decides, as for a person. */
function pluginCaller(plugins: PluginHost): ActPorts['plugins'] {
  const operationOf = (plugin: string, operation: string) =>
    plugins
      .loaded()
      .find((p: KeithPlugin) => p.id === plugin)
      ?.operation(operation)
  return {
    risk: (plugin, operation) => operationOf(plugin, operation)?.risk,
    async call({ plugin, operation, input, actor }) {
      const op = operationOf(plugin, operation)
      if (op === undefined) return { ok: false, code: 'UNKNOWN_OPERATION' }
      try {
        await plugins.guard.run(op, input, {
          principal: { id: actor },
          session: { id: null, kind: 'schedule', method: null, elevated: false },
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, code: error instanceof GuardError ? error.code : 'INTERNAL' }
      }
    },
  }
}

/** Wires the engine, the triggers and their ports. Nothing starts here: `recover` and `beat` are called by the timer. */
export async function createProtocols(w: ProtocolsWiring): Promise<Protocols> {
  const { sqlite, store, parietal, people } = w
  const now = (): number => Date.now()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const settings = createProtocolSettings(w.settings)
  const runs = protocolRunsRepo(sqlite)
  const protocols = protocolsRepo(sqlite)
  const agenda = agendaRepo(sqlite)
  // the agenda answers presence as an overlay (ADR-0025 §2): a confirmed item makes the person busy; parietal's compute is unchanged
  parietal.addOverlay(agendaOverlay({ agenda, timeZone }))
  const signals = presenceSignalsRepo(sqlite)
  // the instance owner is read at use (a transfer of the owner role applies to the next run, the next step and the
  // next notice): `people.owner()` is one read of the people table
  const ownerOf = async (): Promise<string> => (await people.owner())?.id ?? ''
  // the owner-absence settings (P29.1.5): an heir who is suspended or removed is cleared by the identity change
  const successionDeps: SuccessionDeps = {
    settings: w.settings,
    succession: successionRepo(sqlite),
    runs,
    protocols,
    people,
    audit: w.audit,
    lastSign: (personId) => parietal.lastSign(personId),
    lastSignNow: (personId) => signals.newest(personId, LAST_SIGN_TYPES),
    hasSecret: (personId) => w.identity.secrets.kinds(personId).length > 0,
    now,
    // a change of the heir or the window moves the owner-absence built-in to the settings (builtins-succession.ts)
    onChanged: () => {
      syncOwnerAbsenceNow().catch((error: unknown) =>
        w.warn(
          `succession: owner-absence not synced: ${error instanceof Error ? error.message : error}`,
        ),
      )
    },
  }
  const succession = createSuccession(successionDeps)
  // the built-in follows the settings: the heir enables it, the window sets its check-in blocks (a new version)
  async function syncOwnerAbsenceNow(): Promise<void> {
    const owner = await people.owner()
    if (owner === undefined) return
    const settings = succession.settings()
    const sync = syncOwnerAbsence({
      protocols,
      settings: { owner: owner.id, windowDays: settings.windowDays, heir: settings.heir },
      now: now(),
    })
    if (sync.action !== 'unchanged') w.catalog.changed()
  }
  // the sign of life of every person the protocols read: parietal's sign, and a pause counts as a sign (P29.2.6)
  const signOfLife = createSignOfLife({
    lastSign: (personId) => parietal.lastSign(personId),
    pausedUntil: (personId) => succession.pausedUntil(personId),
  })
  w.identity.onIdentityChanged(({ personId, reason }) => {
    if (reason !== 'suspend' && reason !== 'remove') return
    succession
      .heirGone(personId, reason)
      .catch((error: unknown) =>
        w.warn(`succession: heir not cleared: ${error instanceof Error ? error.message : error}`),
      )
  })

  const journalOf = createJournal({
    generations: w.generations,
    audit: (kind, detail) => w.audit.record({ kind, actor: 'system', via: 'local', detail }),
    store,
    warn: w.warn,
  })
  // a run's end is also reported to the plugin that owns the protocol (`k.protocols`, host-port.ts); fire and forget
  const journal: Journal = {
    audit: journalOf.audit,
    event(type, payload) {
      journalOf.event(type, payload)
      if (type !== 'brain.hypothalamus.end') return
      w.protocolsPort
        .runEnded(String(payload.runId), String(payload.status))
        .catch((error: unknown) =>
          w.warn(
            `protocols: run end not reported: ${error instanceof Error ? error.message : error}`,
          ),
        )
    },
  }
  const budgetOf = async (personId: string): Promise<number> =>
    w.budget.statusOf(personId).remainingUsd ?? Number.POSITIVE_INFINITY

  const conditions = {
    clock: { now, timeZone },
    async presence(viewer: string, subject: string) {
      const disclosed = await parietal.disclosedFor(viewer, subject)
      // a condition sees a state only: a level below `state` releases nothing (docs/specs/hypothalamus.md, "Conditions")
      if (disclosed.level !== 'state' && disclosed.level !== 'detail') return null
      return parietal.presence(subject).state
    },
    agenda: {
      async confirmedNow(person: string, at: number) {
        return agenda.busyAt(person, at).length > 0
      },
    },
    lastSign: (person: string) => signOfLife.lastSign(person),
    budget: { remaining: budgetOf },
    approvals: {
      async pending(approvalId: string) {
        const roots = peopleFor('recover', await people.list()).map((p) =>
          frontSessionId(p.id, w.generations.current(p.id)),
        )
        const items = await listAttention({ roots, peek: w.attention.peek, waits: false })
        const item = items.find((i) => i.kind === 'approval' && i.id === approvalId)
        if (item === undefined || item.createdAt === null) return null
        return { expiresAt: item.createdAt + w.approvals.ttlMs() }
      },
    },
  }

  const act = createAct({
    nodes: w.nodes,
    plugins: pluginCaller(w.plugins),
    audit: (detail: FlatDetail) => journal.audit('protocol.act', detail),
  })
  const successionSteps = createSuccessionSteps(successionDeps)
  const steps = createStepRunner({
    deliver: { deliver: (request) => w.delivery.deliver(request) },
    people: {
      async isActive(personId: string) {
        const person = await people.get(personId).catch(() => undefined)
        return person !== undefined && countsFor('route', person.status)
      },
    },
    budget: { remaining: budgetOf },
    act,
    // the built-in owner-absence protocol's coded steps (P29.2.4) and the built-in dream's `dreaming.run` (P35.5.2); no other
    // protocol can hold one (authoring.ts). Without a dreaming service the step answers not-wired.
    system: systemSteps(successionSteps, w.dreaming),
  })

  // the ping of `approval-stale` is the live setting, read at each evaluation (`evaluatedTrigger`, `builtins.ts`)
  const pingBeforeMs = (): number => w.approvals.pingBeforeHours() * MS_HOUR
  const engine = createEngine({
    clock: { now, timeZone },
    conditions,
    protocols,
    runs,
    steps,
    journal,
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf,
    warn: w.warn,
    pingBeforeMs,
  })

  // the built-ins of the self layer: created once, never overwritten (`builtins.ts`)
  seedBuiltIns({ protocols })
  await syncOwnerAbsenceNow().catch((error: unknown) =>
    w.warn(
      `succession: owner-absence not synced: ${error instanceof Error ? error.message : error}`,
    ),
  )
  // the dreaming built-in of each person follows the mode (dream-protocol.ts): a boot sync, then the hook of a mode change
  const dreamModes = dreamingRepo(sqlite)
  const syncDreamOf = async (personId: string, mode?: DreamMode): Promise<void> => {
    const settings = dreamSettingsOf(w.settings)
    const owner = (await people.owner())?.id === personId
    const effective =
      mode ??
      effectiveDreamMode({
        stored: dreamModes.getMode(personId),
        owner,
        memberDefault: settings.memberDefault,
      })
    const sync = syncDream({
      protocols,
      personId,
      mode: effective,
      maxUsdPerRun: settings.maxUsdPerRun,
      now: now(),
    })
    if (sync.action !== 'unchanged') w.catalog.changed()
  }
  for (const person of await people.list()) {
    await syncDreamOf(person.id).catch((error: unknown) =>
      w.warn(`dreaming: dream not synced: ${error instanceof Error ? error.message : error}`),
    )
  }
  w.tools.bind({ engine, runs, protocols })
  // a run that starts is seen by the succession service: the owner-absence run enters its check-in state (P29.2.4)
  const startRun = createRunStarter(engine)
  const triggers = createTriggers({
    runs: {
      async start(input) {
        const outcome = await startRun.start(input)
        if (outcome === 'started') await succession.runStarted(input.protocolId, input.ref)
        return outcome
      },
    },
    protocols: w.catalog,
    feed: {
      async read(query) {
        const records = await store.read({
          after: query.after,
          limit: query.limit,
          types: [...query.types],
        })
        return records.map((r) => ({
          seq: r.seq,
          type: r.type,
          payload: r.payload,
          createdAt: r.createdAt,
        }))
      },
      lastSeq: () => store.lastSeq(),
      prunedThrough: () => store.prunedThrough(),
    },
    signals: { since: async (after, limit) => signals.since(after, limit) },
    lastSign: { lastSign: (personId) => signOfLife.lastSign(personId) },
    schedules: sqliteSchedules(sqlite),
    cursor: settingsCursorStore(w.settings),
    now,
    pingBeforeMs,
    log: { warn: w.warn },
  })

  return {
    engine,
    triggers,
    succession,
    syncDream: syncDreamOf,
    tickMs: () => settings.tickMs(),
    async recover() {
      await succession.reconcileClaimable()
      const report = await engine.recover()
      if (report.resumed > 0 || report.waiting > 0) {
        w.warn(`protocols: recovered ${report.waiting} waiting and ${report.resumed} running runs`)
      }
    },
    async beat() {
      // a claimable state is reconciled at each tick (one read otherwise, succession.md "The claim")
      await succession.reconcileClaimable()
      await triggers.tick()
      await engine.tick()
    },
  }
}
