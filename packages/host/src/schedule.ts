import type { AclStore } from '@keith/acl'
import type { DeliveryFailureNotice, PersonRole } from '@keith/contracts'
import type { Clock, PluginDb, PluginKv } from './types.ts'

/**
 * Scheduling and waking for plugins (docs/specs/plugins.md, "Schedules and wake"). A plugin asks for a
 * timer by key (`k.schedule`); when it comes due the host calls the manifest's `onSchedule` with a
 * `ScheduleFireCtx`, from which the plugin may wake a person's front session. The host owns the clock, the store
 * and the delivery: a plugin never sees the scheduler, a session or an agent.
 */

/** When a timer fires: once at an instant (epoch ms), or on a cron expression (five fields, in the core's local time zone). */
export type ScheduleWhen = { kind: 'once'; at: number } | { kind: 'cron'; expr: string }

/**
 * What happens to slots that came due while the core was down. There is no `skip`: a timer a plugin
 * asks for must not vanish silently. `once` fires the latest missed slot late, `{ max }` the latest `max`;
 * slots dropped beyond that are audited by the host (`plugin.<id>.schedule.skipped`).
 */
export type ScheduleCatchUp = 'once' | { max: number }

export interface ScheduleInput {
  when: ScheduleWhen
  catchUp: ScheduleCatchUp
  /** JSON handed back to `onSchedule` (at most 4 KB; identifiers and short text, never a secret). */
  payload?: unknown
}

export interface ScheduleInfo {
  key: string
  when: ScheduleWhen
  /** The next slot (epoch ms), or null when a `once` timer has fired. */
  nextFireAt: number | null
  lastFireAt: number | null
}

/** The timers of one plugin, by key (unique within the plugin). `set` replaces. */
export interface PluginSchedule {
  set(key: string, input: ScheduleInput): Promise<ScheduleInfo>
  get(key: string): Promise<ScheduleInfo | undefined>
  cancel(key: string): Promise<boolean>
}

/** The port the core implements (one scheduler for every plugin). */
export interface SchedulePort {
  set(pluginId: string, key: string, input: ScheduleInput): Promise<ScheduleInfo>
  get(pluginId: string, key: string): Promise<ScheduleInfo | undefined>
  cancel(pluginId: string, key: string): Promise<boolean>
}

export const SCHEDULE_KEY = /^[A-Za-z0-9_.-]{1,64}$/
export const SCHEDULE_PAYLOAD_MAX = 4 * 1024
/** A cron expression whose next two slots are closer than this is refused (a reminder is not a heartbeat). */
export const MIN_CRON_GAP_MS = 15 * 60_000

/** One slot of a timer, as `onSchedule` receives it. */
export interface ScheduleFire {
  key: string
  /** The slot this fire is for (epoch ms); for a late fire it is the original time. */
  scheduledAt: number
  /** `sched:<id>:<scheduledAt>`: stable across retries of the same slot. */
  fireId: string
  payload: unknown
  /** The slot is older than the scheduler's grace window: the core was down or busy. */
  late: boolean
}

/** What `onSchedule` returns: the slot fired, or was handled without firing (the plugin audits why). */
export type ScheduleOutcome = { fired: true } | { fired: false; reason: string }

/** What the host knows of a person now (never cached). */
export interface PersonFacts {
  id: string
  /** The display name (the id when the directory has none). */
  name: string
  active: boolean
  role: PersonRole
  has(capability: string): boolean
}

/** A turn to start in a person's front session. */
export interface WakeRequest {
  /** The person whose front session is woken; the turn runs as them (their principal, their tools). */
  to: string
  /** Who pays for the turn (a person id); default `to`. Accounting only: it never gives authority. */
  billTo?: string | undefined
  /** The event name the model sees (`<event name="...">`). */
  name: string
  /** What the model reads. The host does not frame it: the plugin must, when the text is not the recipient's own. */
  text: string
  data?: unknown
  /** Run id, stable per slot (`ScheduleFire.fireId`): the same id is delivered once, however often it is asked. */
  id: string
  /**
   * Told to the creator when the wake finally cannot reach the recipient (docs/specs/delivery.md, "Failure notice"):
   * a stored note to `to`, once per `key`. Without it a failure is only audited.
   */
  failureNotice?: DeliveryFailureNotice | undefined
}

/**
 * `delivered: true` with `queued`: the message is accepted but no route took it yet; the core retries it at
 * `nextAttemptAt` and the plugin may count it as fired. A transient outage is never a failure.
 * `delivered: false`: `budget`, the payer has not enough left for one turn; `recipient-gone`, the person to
 * wake is not active (suspended or removed: nothing routes to them, ADR-0027 §15); `unavailable`, the core
 * gave up (no route at all, or every retry ran out).
 */
export type WakeResult =
  | { delivered: true; queued?: { nextAttemptAt: number } | undefined }
  | { delivered: false; reason: 'budget' | 'recipient-gone' | 'unavailable' }

/** The port the core implements. */
export interface WakePort {
  deliver(pluginId: string, request: WakeRequest): Promise<WakeResult>
}

/** What `onSchedule` runs with: the plugin's own storage, a fresh read of people, and the wake. */
export interface ScheduleFireCtx {
  readonly plugin: { id: string }
  readonly clock: Clock
  readonly db: PluginDb
  readonly kv: PluginKv
  readonly acl: AclStore
  readonly schedule: PluginSchedule
  /** Reads a person now; `undefined` when unknown. */
  person(personId: string): Promise<PersonFacts | undefined>
  wake(request: WakeRequest): Promise<WakeResult>
  /** Records `plugin.<id>.<kind>`; `actor` defaults to `system`. Never content or secrets. */
  audit: { record(kind: string, detail?: Record<string, unknown>, actor?: string): void }
}
