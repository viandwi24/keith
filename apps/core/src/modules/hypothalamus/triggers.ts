// The triggers of the hypothalamus region (docs/specs/hypothalamus.md, "Triggers"). A trigger decides when a protocol run
// starts; it never runs a step. Four kinds: `time` (a schedule in `eh_schedules`, the same scheduler the plugins use),
// `absence` (no sign of life from a person), `signal` (presence signals) and `event` (activity feed records, with an
// optional delay; the guard is evaluated by the engine at wake time). Every start goes through `RunStarter`, whose
// unique `(protocol, ref)` guard makes a repeated start a no-op: that is the exactly-once rule of a trigger.
import type { SignalType, Trigger } from '@keith/contracts'
import {
  createScheduler,
  type Schedule,
  type Scheduler,
  type ScheduleStore,
} from 'eharness/scheduler'
import { evaluatedTrigger } from './builtins.ts'
import { approvalRef } from './gate.ts'

type TimeTrigger = Extract<Trigger, { kind: 'time' }>
type AbsenceTrigger = Extract<Trigger, { kind: 'absence' }>
type SignalTrigger = Extract<Trigger, { kind: 'signal' }>
type EventTrigger = Extract<Trigger, { kind: 'event' }>
type FilterMap = NonNullable<SignalTrigger['filter']>

/** What a trigger tells the engine about a start; the engine keeps it on the run. */
export type TriggerDetail =
  | { kind: 'time'; scheduledAt: number; fireId: string }
  | { kind: 'absence'; personId: string; since: number }
  | { kind: 'signal'; signalId: string; personId: string; type: SignalType }
  | {
      kind: 'event'
      seq: number
      type: string
      personId?: string
      deliveryId?: string
      /** Epoch ms the engine waits for (`afterMs` or `until`); absent when the run starts at once. */
      wakeAt?: number
    }

export interface RunStartInput {
  protocolId: string
  version: number
  /** The idempotency key of the run: `<protocolId>:<scheduledAt>`, `absence:<since>`, `signal:<id>`, `event:<seq>`, `delivery:<id>`. */
  ref: string
  /** When the trigger happened (epoch ms). */
  at: number
  detail?: TriggerDetail
}

/** `started`: a new run; `duplicate`: the `(protocol, ref)` run exists already; `refused`: a limit or a pause said no. */
export type RunStartOutcome = 'started' | 'duplicate' | 'refused'

/** The engine's start port. The engine implements it; a start with a known ref never creates a second run. */
export interface RunStarter {
  start(input: RunStartInput): Promise<RunStartOutcome>
}

/** A protocol whose current version is enabled. `savedAt` is when that version was saved: older records never match. */
export interface ActiveProtocol {
  id: string
  version: number
  /** `keith` or a person id. A person-owned protocol matches only that person's records and signals. */
  owner: string
  /** The built-in this protocol is (`builtins.ts`), or null: its trigger may read a live setting (`evaluatedTrigger`). */
  builtIn?: string | null
  savedAt: number
  trigger: Trigger
}

export interface ProtocolCatalog {
  active(): Promise<readonly ActiveProtocol[]>
}

/** One activity feed record (the shape of eharness' `ActivityRecord`, read here only). */
export interface FeedRecord {
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface FeedPort {
  /** Records with `seq > after` and a type in `types`, ascending, at most `limit`. */
  read(query: {
    after: number
    types: readonly string[]
    limit: number
  }): Promise<readonly FeedRecord[]>
  lastSeq(): Promise<number>
  /** The highest seq retention removed; a cursor below it can never be read again. */
  prunedThrough(): Promise<number>
}

/** A presence signal row (P27, `presence_signals`). `detail` is the small flat JSON the signal carries. */
export interface SignalRow {
  id: string
  personId: string
  clientId: string | null
  type: SignalType
  at: number
  detail: Record<string, string | number | boolean | null> | null
}

export interface SignalCursor {
  at: number
  id: string
}

export interface SignalsPort {
  /**
   * Signals after the cursor in the order `(at, id)`, at most `limit`: `at > after.at`, or `at = after.at` and
   * `id > after.id`. The P27 repo offers only `newest` today; the wiring adds this read (docs/specs/parietal.md).
   */
  since(after: SignalCursor, limit: number): Promise<readonly SignalRow[]>
}

export interface LastSignPort {
  /** The newest sign of life of a person (parietal's `lastSign`), or null when there is none. */
  lastSign(personId: string): Promise<number | null>
}

export interface TriggerCursor {
  /** Last activity feed seq handled: every record at or below it is done. */
  events: number
  signals: SignalCursor
}

export interface CursorStore {
  get(): TriggerCursor | undefined
  set(cursor: TriggerCursor): void
}

/** The settings key of the trigger cursor (docs/specs/hypothalamus.md, "Triggers"). */
export const TRIGGER_CURSOR_KEY = 'protocols.cursor'

const isCursor = (value: unknown): value is TriggerCursor => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const s = v.signals as Record<string, unknown> | undefined
  return (
    typeof v.events === 'number' &&
    Number.isInteger(v.events) &&
    v.events >= 0 &&
    typeof s === 'object' &&
    s !== null &&
    typeof s.at === 'number' &&
    typeof s.id === 'string'
  )
}

/** The cursor over the settings repo. A stored value that is not a cursor reads as none (the first tick starts at the head). */
export function settingsCursorStore(settings: {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}): CursorStore {
  return {
    get() {
      const stored = settings.get<unknown>(TRIGGER_CURSOR_KEY)
      return isCursor(stored) ? stored : undefined
    },
    set(cursor) {
      settings.set(TRIGGER_CURSOR_KEY, cursor)
    },
  }
}

export interface TriggersOptions {
  runs: RunStarter
  protocols: ProtocolCatalog
  feed: FeedPort
  signals: SignalsPort
  lastSign: LastSignPort
  /** The eharness schedule store. Shared with the plugin scheduler: this module only sees the `protocol:` rows. */
  schedules: ScheduleStore
  cursor: CursorStore
  now: () => number
  /**
   * The live ping offset of `approval-stale` in ms (`approvals.pingBeforeHours`), read each time an event trigger is
   * evaluated. A ping change applies to the approvals that start waiting after it; a pending one moves at its wake time.
   */
  pingBeforeMs: () => number
  log?: { warn(message: string): void }
  /** Rows read per source per tick (default 200). */
  pageLimit?: number
}

export interface TriggerTickReport {
  /** The time schedules were reconciled with the protocols in this tick. */
  reconciled: boolean
  /** Runs started, by trigger kind (`refused` and `duplicate` are not counted). */
  started: { time: number; absence: number; signal: number; event: number }
}

export interface Triggers {
  /** One pass: reconcile the time schedules when the protocols changed, fire due slots, then absence, signals and events. */
  tick(): Promise<TriggerTickReport>
}

const SESSION_PREFIX = 'protocol:'

/** The schedule id of a time trigger: one per protocol version (the idempotent key of the registration). */
export const timeScheduleId = (protocolId: string, version: number): string =>
  `${SESSION_PREFIX}${protocolId}:v${version}`

/** Next slot of a cron expression after `after` (the core's zone), `undefined` when there is none or it is invalid. */
export function nextCronSlot(expr: string, after: number): number | undefined {
  try {
    const next = Bun.cron.parse(expr, new Date(after))
    return next === null ? undefined : next.getTime()
  } catch {
    return undefined
  }
}

/**
 * The store this module schedules on: only the rows of protocols (`protocol:` sessions) are visible here, so this
 * scheduler never claims a plugin's row. The plugin scheduler needs the same scoping on its side (wiring note in the spec).
 */
export function protocolScope(store: ScheduleStore): ScheduleStore {
  const scoped: ScheduleStore = {
    get: (id) => store.get(id),
    list: (query) => store.list(query),
    put: (schedule) => store.put(schedule),
    delete: (id) => store.delete(id),
    due: async (now, limit) =>
      (await store.due(now, limit)).filter((s: Schedule) => s.sessionId.startsWith(SESSION_PREFIX)),
    claim: (id, version, owner, leaseUntil) => store.claim(id, version, owner, leaseUntil),
    complete: (id, owner, advance) => store.complete(id, owner, advance),
    release: (id, owner) => store.release(id, owner),
  }
  const update = store.update
  if (update !== undefined) {
    scoped.update = (schedule, expectedVersion) => update.call(store, schedule, expectedVersion)
  }
  return scoped
}

const matchesFilter = (filter: FilterMap | undefined, fields: Record<string, unknown>): boolean =>
  filter === undefined || Object.entries(filter).every(([key, value]) => fields[key] === value)

/** A person-owned protocol matches only records about its owner; a keith-owned one is not limited here. */
const ownedBy = (protocol: ActiveProtocol, personId: string | undefined): boolean =>
  protocol.owner === 'keith' || personId === protocol.owner

export function createTriggers(options: TriggersOptions): Triggers {
  const now = options.now
  const pageLimit = options.pageLimit ?? 200
  const warn = (message: string): void => options.log?.warn(message)

  // The cursor is read from the store once (at the first tick) and kept here: only this module writes it, so an idle
  // tick reads no settings row. The first tick that finds none starts at the head (see `tick`): a fresh core never
  // replays the feed history into new protocols.
  let known: TriggerCursor | undefined
  const readCursor = (): TriggerCursor => {
    if (known === undefined) throw new Error('trigger cursor is not initialised')
    return known
  }
  const saveCursor = (cursor: TriggerCursor): void => {
    known = cursor
    options.cursor.set(cursor)
  }

  // ----- time: eharness scheduler over the protocol rows -----
  const scheduler: Scheduler = createScheduler({
    store: protocolScope(options.schedules),
    now,
    next: (expr, after) => nextCronSlot(expr, after),
    onError: (error, context) =>
      warn(
        `triggers: ${context.scheduleId ?? '?'}: ${error instanceof Error ? error.message : error}`,
      ),
    async fire({ schedule, scheduledAt, fireId }) {
      const payload = schedule.payload as { protocolId?: unknown; version?: unknown } | null
      if (typeof payload?.protocolId !== 'string' || typeof payload.version !== 'number') {
        return { fired: false }
      }
      const outcome = await options.runs.start({
        protocolId: payload.protocolId,
        version: payload.version,
        ref: `${payload.protocolId}:${scheduledAt}`,
        at: scheduledAt,
        detail: { kind: 'time', scheduledAt, fireId },
      })
      return { fired: outcome === 'started' }
    },
  })

  let lastSignature: string | undefined
  let initialised = false
  const timeSignature = (active: readonly ActiveProtocol[]): string =>
    active
      .filter((p) => p.trigger.kind === 'time')
      .map((p) => `${p.id}@${p.version}:${JSON.stringify(p.trigger)}`)
      .sort()
      .join('|')

  const ownedRows = async (): Promise<Schedule[]> => {
    const rows: Schedule[] = []
    let cursor: string | undefined
    do {
      const page = await options.schedules.list({
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of page.items) {
        if (row.sessionId.startsWith(SESSION_PREFIX)) rows.push(row)
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return rows
  }

  /** Makes the `protocol:` rows match the enabled time triggers: one row per version, stale versions removed. */
  const reconcile = async (active: readonly ActiveProtocol[]): Promise<void> => {
    const wanted = new Map<string, { protocol: ActiveProtocol; trigger: TimeTrigger }>()
    for (const protocol of active) {
      if (protocol.trigger.kind === 'time') {
        wanted.set(timeScheduleId(protocol.id, protocol.version), {
          protocol,
          trigger: protocol.trigger,
        })
      }
    }
    const existing = await ownedRows()
    const present = new Set(existing.map((row) => row.id))
    // A fired one-shot keeps its row while its version is wanted: that row is the idempotency record, so a restart
    // never fires it a second time.
    for (const row of existing) {
      if (!wanted.has(row.id)) await scheduler.remove(row.id)
    }
    for (const [id, { protocol, trigger }] of wanted) {
      if (present.has(id)) continue
      try {
        await scheduler.create({
          id,
          sessionId: `${SESSION_PREFIX}${protocol.id}`,
          spec:
            trigger.cron === undefined
              ? { kind: 'once', at: trigger.at ?? 0 }
              : { kind: 'cron', expr: trigger.cron },
          catchUp: 'once',
          overlap: 'skip',
          payload: { protocolId: protocol.id, version: protocol.version },
        })
      } catch (error) {
        warn(
          `triggers: cannot schedule ${protocol.id} v${protocol.version}: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
  }

  // ----- absence: one run per absence period, anchored on the newer of the last sign and the save -----
  const armed = new Map<string, number>()

  const checkAbsence = async (
    protocol: ActiveProtocol,
    trigger: AbsenceTrigger,
  ): Promise<number> => {
    const last = await options.lastSign.lastSign(trigger.person)
    if (last === null) return 0 // a person with no sign at all is never absent
    const since = Math.max(last, protocol.savedAt)
    if (now() - since < trigger.afterMs) return 0
    if (armed.get(protocol.id) === since) return 0
    // the period is consumed whatever the answer: a refused start is not retried on every tick
    armed.set(protocol.id, since)
    const outcome = await options.runs.start({
      protocolId: protocol.id,
      version: protocol.version,
      ref: `absence:${since}`,
      at: now(),
      detail: { kind: 'absence', personId: trigger.person, since },
    })
    return outcome === 'started' ? 1 : 0
  }

  // ----- signals -----
  const signalMatches = (
    protocol: ActiveProtocol,
    trigger: SignalTrigger,
    row: SignalRow,
  ): boolean => {
    if (row.type !== trigger.type) return false
    if (!ownedBy(protocol, row.personId)) return false
    if (row.at < protocol.savedAt) return false
    // the detail, then the identity fields (they win over a detail key of the same name)
    const fields: Record<string, unknown> = {
      ...(row.detail ?? {}),
      personId: row.personId,
      clientId: row.clientId,
      type: row.type,
    }
    return matchesFilter(trigger.filter, fields)
  }

  const drainSignals = async (active: readonly ActiveProtocol[]): Promise<number> => {
    const triggers = active.filter(
      (p): p is ActiveProtocol & { trigger: SignalTrigger } => p.trigger.kind === 'signal',
    )
    // nothing listens: no read and no write (an idle tick, docs/specs/hypothalamus.md "Tick")
    if (triggers.length === 0) return 0
    const cursor = readCursor()
    // a rule matches no row older than its save (`savedAt`): a stale cursor is moved up to the oldest save, so a
    // protocol saved after a long quiet period never replays the signals before it
    const oldestSave = Math.min(...triggers.map((p) => p.savedAt))
    let progress = oldestSave > cursor.signals.at ? { at: oldestSave, id: '' } : cursor.signals
    const before = cursor.signals
    let started = 0
    try {
      for (const row of await options.signals.since(progress, pageLimit)) {
        for (const protocol of triggers) {
          if (!signalMatches(protocol, protocol.trigger, row)) continue
          const outcome = await options.runs.start({
            protocolId: protocol.id,
            version: protocol.version,
            ref: `signal:${row.id}`,
            at: row.at,
            detail: { kind: 'signal', signalId: row.id, personId: row.personId, type: row.type },
          })
          if (outcome === 'started') started++
        }
        progress = { at: row.at, id: row.id }
      }
    } finally {
      if (progress.at !== before.at || progress.id !== before.id) {
        saveCursor({ ...readCursor(), signals: progress })
      }
    }
    return started
  }

  // ----- events -----
  const eventWakeAt = (trigger: EventTrigger, record: FeedRecord): number | undefined => {
    if (trigger.afterMs !== undefined) return record.createdAt + trigger.afterMs
    if (trigger.until !== undefined) {
      const at = record.payload[trigger.until.field]
      return typeof at === 'number' && Number.isFinite(at)
        ? at - trigger.until.beforeMs
        : Number.NaN
    }
    return undefined
  }

  // The ref of a `delivery.failed` record is its delivery id, so one failed delivery makes one run per protocol.
  const eventRef = (record: FeedRecord): string => {
    const deliveryId = record.payload.deliveryId
    if (record.type === 'delivery.failed' && typeof deliveryId === 'string') {
      return `delivery:${deliveryId}`
    }
    // an approval that starts waiting is one run per approval (its guard reads the approval, `gate.ts`)
    const approvalId = record.payload.approvalId
    if (record.type === 'brain.amygdala.wait' && typeof approvalId === 'string') {
      return approvalRef(approvalId)
    }
    return `event:${record.seq}`
  }

  const drainEvents = async (active: readonly ActiveProtocol[]): Promise<number> => {
    const triggers = active.filter(
      (p): p is ActiveProtocol & { trigger: EventTrigger } => p.trigger.kind === 'event',
    )
    // nothing listens: no read and no write
    if (triggers.length === 0) return 0
    const cursor = readCursor()
    // no row past the cursor: one head read and nothing else
    if ((await options.feed.lastSeq()) <= cursor.events) return 0
    let progress = Math.max(cursor.events, await options.feed.prunedThrough())
    const before = cursor.events
    let started = 0
    // the trigger as evaluated now: the built-in's ping is the live setting (read once per drain)
    const live = triggers.map((protocol) => ({
      protocol,
      trigger: evaluatedTrigger(protocol.trigger, protocol.builtIn, options.pingBeforeMs),
    }))
    try {
      const types = [...new Set(triggers.map((p) => p.trigger.type))]
      const records = await options.feed.read({ after: progress, types, limit: pageLimit })
      for (const record of records) {
        for (const { protocol, trigger } of live) {
          if (trigger.type !== record.type) continue
          if (record.createdAt < protocol.savedAt) continue
          const personId =
            typeof record.payload.personId === 'string' ? record.payload.personId : undefined
          if (!ownedBy(protocol, personId)) continue
          if (!matchesFilter(trigger.filter, record.payload)) continue
          const wakeAt = eventWakeAt(trigger, record)
          if (typeof wakeAt === 'number' && Number.isNaN(wakeAt)) {
            warn(`triggers: ${protocol.id}: event ${record.seq} carries no time for \`until\``)
            continue
          }
          const deliveryId =
            typeof record.payload.deliveryId === 'string' ? record.payload.deliveryId : undefined
          const outcome = await options.runs.start({
            protocolId: protocol.id,
            version: protocol.version,
            ref: eventRef(record),
            at: record.createdAt,
            detail: {
              kind: 'event',
              seq: record.seq,
              type: record.type,
              ...(personId === undefined ? {} : { personId }),
              ...(deliveryId === undefined ? {} : { deliveryId }),
              ...(wakeAt === undefined ? {} : { wakeAt }),
            },
          })
          if (outcome === 'started') started++
        }
        progress = record.seq
      }
    } finally {
      if (progress !== before) saveCursor({ ...readCursor(), events: progress })
    }
    return started
  }

  return {
    async tick() {
      if (!initialised) {
        // first run of this store: start at the head of the feed and of the signals (no replay of history)
        let stored = options.cursor.get()
        if (stored === undefined) {
          stored = { events: await options.feed.lastSeq(), signals: { at: now(), id: '' } }
          options.cursor.set(stored)
        }
        known = stored
        initialised = true
      }
      const active = await options.protocols.active()
      const signature = timeSignature(active)
      let reconciled = false
      if (signature !== lastSignature) {
        await reconcile(active)
        lastSignature = signature
        reconciled = true
      }
      const idle = { time: 0, absence: 0, signal: 0, event: 0 }
      // no enabled protocol: the pass ends here, so an idle core reads nothing (docs/specs/hypothalamus.md "Tick")
      if (active.length === 0) return { reconciled, started: idle }
      const time = active.some((p) => p.trigger.kind === 'time')
        ? (await scheduler.tick()).fired.length
        : 0
      let absence = 0
      for (const protocol of active) {
        if (protocol.trigger.kind !== 'absence') continue
        try {
          absence += await checkAbsence(protocol, protocol.trigger)
        } catch (error) {
          warn(
            `triggers: absence ${protocol.id}: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
      const signal = await drainSignals(active)
      const event = await drainEvents(active)
      return { reconciled, started: { time, absence, signal, event } }
    },
  }
}
