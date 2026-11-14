import { GUEST_LIMITS } from '@keith/contracts'
import type { SettingsRepo, Sqlite } from '@keith/db'
import { harnessNameOf } from '@keith/host'
import type { HarnessLogger, HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import type { Audit } from './modules/audit/index.ts'
import type { LanNets } from './modules/auth/index.ts'
import type { Budget } from './modules/budget/index.ts'
import {
  createEntryGate,
  createGuestAdmin,
  createGuestAudit,
  createGuestBudget,
  createGuestLogger,
  createGuestRegistry,
  createGuestSettings,
  type EntryGate,
  GUEST_TOOL_ALLOWLIST,
  type GuestAdmin,
  type GuestAudit,
  type GuestRegistry,
  type GuestSettingsStore,
} from './modules/guests/index.ts'
import { type ProviderService, resolveRoleModel } from './modules/providers/index.ts'
import {
  createBearerStore,
  createGuestHttp,
  createIpHasher,
  createStartLimiter,
  type GuestHttp,
} from './modules/thalamus/index.ts'

/**
 * Only the plugins that own an allow-listed tool are given to the guest agent (`notes_public_get` -> plugin `notes`),
 * so a plugin that has nothing for visitors is not even loaded into their agent. The allow-list and the guard's
 * visibility rules still apply to the tools of the ones that are.
 */
function guestPlugins(compiled: readonly HarnessPlugin[]): HarnessPlugin[] {
  const names = new Set(
    GUEST_TOOL_ALLOWLIST.map((tool) => harnessNameOf(tool.slice(0, tool.indexOf('_')))),
  )
  return compiled.filter((plugin) => names.has((plugin as { name?: string }).name ?? ''))
}

export interface GuestsRuntime {
  admin: GuestAdmin
  registry: GuestRegistry
  store: GuestSettingsStore
  gate: EntryGate
  /** The recording of guest mode: session rows, refusal rows and the cap notice (`close` writes what is pending). */
  audit: GuestAudit
}

/**
 * The guest listener's `fetch` over a core's guest registry (docs/specs/guests.md, "Guest HTTP"): the Host guard of that
 * listener, the zone check, the per-IP window and the bearer store, all in memory. The server that listens
 * (`createGuestListener`) is the caller's.
 */
export function createGuestFetch(options: {
  guests: GuestsRuntime
  lan: () => LanNets
  publicUrl: () => string | null | undefined
  onDenied?: (denied: { ipHash: string; reason: string }) => void
  /** Tests: names the Host guard accepts besides addresses (default: this machine's hostname). */
  ownNames?: () => readonly string[]
  /** Tests: the clock of the per-address start window. */
  now?: () => number
  /** The visitor's text for a failed turn: the persona's `guestUnavailable` line (`prefrontal/lines.ts`). */
  guestLine?: () => string
}): GuestHttp {
  const { guests } = options
  return createGuestHttp({
    registry: guests.registry,
    settings: guests.store,
    gate: guests.gate,
    lan: options.lan,
    hasher: createIpHasher(),
    limiter: createStartLimiter({
      max: () => guests.store.get().sessionsPerIpPerWindow,
      windowMs: GUEST_LIMITS.ipWindowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    statusLimiter: createStartLimiter({
      max: () => GUEST_LIMITS.statusPerIpPerWindow,
      windowMs: GUEST_LIMITS.statusWindowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    bearers: createBearerStore(),
    publicUrl: () => options.publicUrl() ?? undefined,
    // refusals are counted per address hash per minute and written as aggregate rows
    onDenied: options.onDenied ?? guests.audit.denied,
    ...(options.ownNames === undefined ? {} : { ownNames: options.ownNames }),
    ...(options.guestLine === undefined ? {} : { guestLine: options.guestLine }),
  })
}

/**
 * Guest mode of a core (docs/specs/guests.md): settings, budget scopes, the entry gate, the in-memory registry
 * with its sweeper, and the owner's admin over them. The registry touches no durable store; only the budget
 * ledger (amounts per scope) and the owner's settings live in the database.
 */
export function createGuests(options: {
  sqlite: Sqlite
  settings: SettingsRepo
  providers: ProviderService
  budget: Budget
  publicUrl: () => string | null | undefined
  logger: HarnessLogger
  /** The security log and the owner's feed: aggregate rows and the cap notice go here (never text). */
  audit: Audit
  store: ActivityStore
  /** The compiled plugins of the host: the guest agent gets only the ones that own an allow-listed tool. */
  plugins?: readonly HarnessPlugin[]
  /** The `activity-logs` plugin of every guest agent (ADR-0032 §1). */
  activityLogs?: HarnessPlugin
  /** Test timers (ms). */
  timing?: { sweepEveryMs?: number; graceMs?: number }
  /** Tests: the clock of the sessions (idle and absolute expiry). */
  now?: () => number
}): GuestsRuntime {
  const store = createGuestSettings(options.settings)
  const budget = createGuestBudget({ sqlite: options.sqlite, store, budget: options.budget })
  const gate = createEntryGate({ store, providers: options.providers, budget })
  const recording = createGuestAudit({
    audit: options.audit,
    store: options.store,
    warn: (message) => options.logger.warn(message, { code: 'GUEST_AUDIT' }),
  })
  const registry = createGuestRegistry({
    store,
    gate,
    budget,
    model: () => resolveRoleModel('guest', options.providers),
    catalog: options.providers.catalog(),
    logger: options.logger,
    // the guest path logs a code, the session id and the address hash, nothing else
    sessionLogger: (context) => createGuestLogger(options.logger, context),
    onEnd: recording.onEnd,
    plugins: guestPlugins(options.plugins ?? []),
    ...(options.activityLogs === undefined ? {} : { activityLogs: options.activityLogs }),
    ...options.timing,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const admin = createGuestAdmin({
    store,
    providers: options.providers,
    sessions: registry,
    gate,
    budget,
    publicUrl: options.publicUrl,
  })
  return { admin, registry, store, gate, audit: recording }
}
