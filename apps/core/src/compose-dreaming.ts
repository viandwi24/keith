// The memory dreaming region as the core holds it (docs/specs/dreaming.md, "Service"; ADR-0031 §3 to §8): the run service, built
// from the judge's ports (providers for the `cortex` role, the person's budget scope, the activity-logs plugin; the judge keeps
// no transcript, so it needs no storage and no lock), the delivery service for the staged notice and the budget notice, the audit and the activity feed. The service's
// run port goes to the protocol engine (`createProtocols`, `dreaming`); a mode change re-syncs the person's `dream` built-in.
// compose.ts calls it before the protocols and the edge, so both can reach it.

import { DREAM_SETTING_KEYS, type DreamingSettingsSet, type DreamMode } from '@keith/contracts'
import { dreamingRepo, type SettingsRepo, type Sqlite } from '@keith/db'
import type { HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import type { createIdentity } from './compose-identity.ts'
import { emit } from './modules/brain-events/index.ts'
import type { Budget } from './modules/budget/index.ts'
import type { Delivery } from './modules/delivery/index.ts'
import { judge } from './modules/hippocampus/dream/judge.ts'
import { dreamProcedures } from './modules/hippocampus/dream/procedures.ts'
import { createDreamService, type DreamService } from './modules/hippocampus/dream/service.ts'
import type { DreamingRunPort } from './modules/hypothalamus/index.ts'
import { dreamSettingsOf } from './modules/hypothalamus/index.ts'
import type { ProviderService } from './modules/providers/index.ts'
import type { FrontGenerationOf } from './platform/sessions.ts'

type Identity = ReturnType<typeof createIdentity>

export interface DreamingWiring {
  dataDir: string
  sqlite: Sqlite
  settings: SettingsRepo
  generations: FrontGenerationOf
  identity: Pick<Identity, 'people' | 'audit' | 'aclAudit'>
  providers: ProviderService
  budget: Budget
  /** The `activity-logs` plugin: the judge's model calls are recorded under the person (ADR-0032 §1). */
  activityLogs: HarnessPlugin
  delivery: Pick<Delivery, 'deliver'>
  store: ActivityStore
  /** Re-syncs the person's `dream` built-in (`createProtocols`, `syncDream`): to `mode` after a mode change, to the effective mode otherwise. */
  syncDream(personId: string, mode?: DreamMode): Promise<void>
  warn: (message: string) => void
}

export interface DreamingRegion {
  /** The run service: the core's own callers and the procedures use it. */
  service: DreamService
  /** The RPC procedures of the `dream` area (`dream.*`). */
  procedures: ReturnType<typeof dreamProcedures>
  /** The run port of the protocol engine's `dreaming.run` step. */
  port: DreamingRunPort
}

export function createDreaming(w: DreamingWiring): DreamingRegion {
  const service = createDreamService({
    dataDir: w.dataDir,
    sqlite: w.sqlite,
    repo: dreamingRepo(w.sqlite),
    generations: w.generations,
    owner: { isOwner: async (personId) => (await w.identity.people.owner())?.id === personId },
    // the settings in force, read at each use: a change applies to the next run and the next mode
    settings: () => dreamSettingsOf(w.settings),
    // what the person has left (own cap, bounded by the global limit): a run under the judge's reservation is skipped
    budgetRemaining: (personId) => w.budget.statusOf(personId).remainingUsd,
    judge: (personId, candidates, maxUsdPerRun) =>
      judge(personId, candidates, {
        providers: w.providers,
        budget: w.budget,
        dataDir: w.dataDir,
        maxUsdPerRun,
        activityLogs: w.activityLogs,
      }),
    audit: { record: (event) => w.identity.audit.record(event) },
    activity: {
      record: (sessionId, type, payload) => emit(w.store, type, sessionId, null, payload, w.warn),
    },
    warn: w.warn,
    deliver: (request) => w.delivery.deliver(request),
    onModeChanged: (personId, mode) => w.syncDream(personId, mode),
  })
  // a run the core stopped during (no run is live at boot) ends as failed, reason interrupted, and its end event clears the
  // client's `dreaming…` (docs/specs/dreaming.md)
  const interrupted = service.endInterrupted()
  if (interrupted > 0)
    w.warn(`dreaming: ${interrupted} run(s) the core stopped during ended as failed`)
  const procedures = dreamProcedures({
    service,
    owner: { isOwner: async (personId) => (await w.identity.people.owner())?.id === personId },
    people: { get: (personId) => w.identity.people.get(personId) },
    aclAudit: w.identity.aclAudit,
    settings: {
      read: () => dreamSettingsOf(w.settings),
      write(change: DreamingSettingsSet) {
        if (change.maxUsdPerRun !== undefined)
          w.settings.set(DREAM_SETTING_KEYS.maxUsdPerRun, change.maxUsdPerRun)
        if (change.memberDefault !== undefined)
          w.settings.set(DREAM_SETTING_KEYS.memberDefault, change.memberDefault)
      },
    },
    syncEveryone: async () => {
      for (const person of await w.identity.people.list()) await w.syncDream(person.id)
    },
  })
  return { service, port: service, procedures }
}
