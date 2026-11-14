import type { AclStore } from '@keith/acl'
import {
  type ActorDirectory,
  type AuditPort,
  type KeithPlugin,
  MIN_CRON_GAP_MS,
  OperationError,
  type PluginSchedule,
  type PluginStorage,
  SCHEDULE_KEY,
  SCHEDULE_PAYLOAD_MAX,
  type ScheduleFireCtx,
  type ScheduleInfo,
  type SchedulePort,
  type WakePort,
} from '@keith/host'
import {
  createScheduler,
  type Schedule,
  type ScheduleStore,
  type TickReport,
} from 'eharness/scheduler'

/** The scheduler's session id: a schedule belongs to a plugin, the fire decides whom it wakes. */
const sessionOf = (pluginId: string): string => `plugin:${pluginId}`
const idOf = (pluginId: string, key: string): string => `${pluginId}:${key}`

/**
 * A slot a plugin's timer declined while the plugin was not loaded (P24.6.3). The scheduler has already moved past
 * it (a declined slot is consumed, and a once timer has no next slot), so the host keeps it and replays it once
 * when the plugin loads again, with `late: true`.
 */
export interface CatchupSlot {
  key: string
  scheduledAt: number
  fireId: string
}
/** Declined slots kept per plugin (one per timer key: the latest); the oldest keys go first. */
export const CATCHUP_MAX = 100

/** Where declined slots wait, per plugin. Core: the settings repo (`plugins.catchup.<id>`); tests: memory. */
export interface CatchupStore {
  get(pluginId: string): CatchupSlot[]
  set(pluginId: string, slots: CatchupSlot[]): void
}

export const catchupKey = (pluginId: string): string => `plugins.catchup.${pluginId}`

/** The catch-up store over the settings repo: a JSON list per plugin, capped at `CATCHUP_MAX`. */
export function settingsCatchup(settings: {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}): CatchupStore {
  return {
    get(pluginId) {
      const v = settings.get<CatchupSlot[]>(catchupKey(pluginId))
      return Array.isArray(v) ? v : []
    },
    set(pluginId, slots) {
      settings.set(catchupKey(pluginId), slots.slice(-CATCHUP_MAX))
    },
  }
}

/** The catch-up store in memory (the default; a process keeps what it declined until it stops). */
export function memoryCatchup(): CatchupStore {
  const held = new Map<string, CatchupSlot[]>()
  return {
    get: (pluginId) => held.get(pluginId) ?? [],
    set: (pluginId, slots) => void held.set(pluginId, slots.slice(-CATCHUP_MAX)),
  }
}

interface Payload {
  plugin: string
  key: string
  data: unknown
}

export interface ScheduleServiceOptions {
  store: ScheduleStore
  /** The loaded plugins (lazy: the host is built before the scheduler starts). */
  plugins: () => readonly KeithPlugin[]
  storage: (pluginId: string) => PluginStorage
  directory: ActorDirectory
  acl: AclStore
  audit: AuditPort
  wake: WakePort
  /** Display names for `ctx.person` (default: the id). */
  names?: (personId: string) => Promise<string | undefined>
  log: { info(message: string): void; warn(message: string): void }
  now?: () => number
  tickMs?: number
  graceMs?: number
  /** Declined slots of plugins that were not loaded (default: in memory). */
  catchup?: CatchupStore
}

export interface ScheduleService {
  /** What `k.schedule` talks to. */
  readonly port: SchedulePort
  /**
   * Fires what is due now (a slot that came due while the core was down fires here, once), then ticks every `tickMs`.
   * A plugin that was off and is loaded again first gets the latest slot each of its timers declined (`late: true`).
   */
  start(): Promise<void>
  stop(): Promise<void>
  /** One tick (tests). */
  tick(): Promise<TickReport>
}

/** Next slot of a cron expression after `after` (local time zone of the core), `undefined` when none or invalid. */
export function nextCron(expr: string, after: number): number | undefined {
  try {
    const next = Bun.cron.parse(expr, new Date(after))
    return next === null ? undefined : next.getTime()
  } catch {
    return undefined
  }
}

/** The id and session prefix of the protocol rows (`modules/hypothalamus/triggers.ts`) in the shared `eh_schedules`. */
const PROTOCOL_PREFIX = 'protocol:'

/** A row of the protocol triggers, not a plugin's timer: the plugin scheduler never reads or claims it. */
export const isProtocolRow = (row: Pick<Schedule, 'id' | 'sessionId'>): boolean =>
  row.id.startsWith(PROTOCOL_PREFIX) || row.sessionId.startsWith(PROTOCOL_PREFIX)

/**
 * The store the plugin scheduler sees: the same `eh_schedules` table as the protocol triggers, minus their rows
 * (docs/specs/hypothalamus.md, "Triggers"). A protocol one-shot is never consumed by a plugin's scheduler.
 */
export function pluginScope(store: ScheduleStore): ScheduleStore {
  const scoped: ScheduleStore = {
    get: async (id) => {
      const row = await store.get(id)
      return row === undefined || isProtocolRow(row) ? undefined : row
    },
    list: async (query) => {
      const page = await store.list(query)
      return { ...page, items: page.items.filter((row) => !isProtocolRow(row)) }
    },
    put: (schedule) => store.put(schedule),
    delete: (id) => store.delete(id),
    due: async (now, limit) => (await store.due(now, limit)).filter((s) => !isProtocolRow(s)),
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

/**
 * The scheduler of the plugin layer (docs/specs/plugins.md, "Schedules and wake"): one `eharness/scheduler` over
 * `eh_schedules`. A plugin's timer is a schedule `<plugin>:<key>` whose payload names the plugin; when it is
 * due the host runs the plugin's `onSchedule` with a context that can read people now and wake a front session.
 * Slots dropped by catch-up are audited here; a slot the plugin declines is audited by the plugin; a plugin that is
 * not loaded declines its slots (audited, `plugin-off`); a throw is logged and audited and the slot is dropped.
 */
export function createScheduleService(options: ScheduleServiceOptions): ScheduleService {
  const now = options.now ?? Date.now
  const audit = (kind: string, detail: Record<string, unknown>, actor = 'system'): void => {
    try {
      options.audit.record({ kind, actor, via: 'local', detail })
    } catch (error) {
      options.log.warn(`schedules: audit failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  const pluginOf = (id: string): KeithPlugin | undefined =>
    options.plugins().find((p) => p.id === id)
  const catchup = options.catchup ?? memoryCatchup()
  // one declined slot per timer key: the latest replaces the earlier one
  const keepDeclined = (pluginId: string, slot: CatchupSlot): void => {
    const kept = catchup.get(pluginId).filter((s) => s.key !== slot.key)
    catchup.set(pluginId, [...kept, slot])
  }

  const infoOf = (s: Schedule): ScheduleInfo => ({
    key: (s.payload as Payload).key,
    when:
      s.spec.kind === 'cron'
        ? { kind: 'cron', expr: s.spec.expr }
        : { kind: 'once', at: s.spec.kind === 'once' ? s.spec.at : 0 },
    nextFireAt: s.nextFireAt,
    lastFireAt: s.lastFireAt ?? null,
  })

  const fireCtx = (plugin: KeithPlugin): ScheduleFireCtx => {
    const storage = options.storage(plugin.id)
    return {
      plugin: { id: plugin.id },
      clock: { now },
      db: storage.db,
      kv: storage.kv,
      acl: options.acl,
      schedule: portFor(plugin.id),
      async person(personId) {
        const facts = await options.directory.resolve(personId)
        if (facts === undefined || facts.actor.personId !== personId) return undefined
        return {
          id: personId,
          name: (await options.names?.(personId)) ?? personId,
          active: facts.status === 'active',
          role: facts.actor.role ?? 'member',
          has: (capability) => facts.capabilities.has(capability),
        }
      },
      wake: (request) => options.wake.deliver(plugin.id, request),
      audit: {
        record: (kind, detail, actor) =>
          audit(`plugin.${plugin.id}.${kind}`, { ...(detail ?? {}) }, actor ?? 'system'),
      },
    }
  }

  const scheduler = createScheduler({
    store: options.store,
    now,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    next: (expr, after) => nextCron(expr, after),
    onError: (error, context) =>
      options.log.warn(
        `schedules: ${context.scheduleId ?? '?'}: ${error instanceof Error ? error.message : error}`,
      ),
    async fire({ schedule, scheduledAt, fireId }) {
      const payload = schedule.payload as Payload
      // F-020: a cron slot whose next slot is already due is superseded; the scheduler fires the later one.
      // Declined here (not kept for catch-up), so a boot tick fires at most the latest slot of a cron.
      if (schedule.spec.kind === 'cron') {
        const next = nextCron(schedule.spec.expr, scheduledAt)
        if (next !== undefined && next <= now()) {
          audit(`plugin.${payload.plugin}.schedule.skipped`, {
            key: payload.key,
            scheduledAt,
            reason: 'superseded',
          })
          return { fired: false }
        }
      }
      const plugin = pluginOf(payload.plugin)
      if (plugin?.manifest.onSchedule === undefined) {
        keepDeclined(payload.plugin, { key: payload.key, scheduledAt, fireId })
        audit(`plugin.${payload.plugin}.schedule.skipped`, {
          key: payload.key,
          scheduledAt,
          reason: 'plugin-off',
        })
        return { fired: false }
      }
      try {
        const outcome = await plugin.manifest.onSchedule(
          {
            key: payload.key,
            scheduledAt,
            fireId,
            payload: payload.data,
            late: now() - scheduledAt > (options.graceMs ?? 2 * (options.tickMs ?? 15_000)),
          },
          fireCtx(plugin),
        )
        return outcome.fired ? { fired: true } : { fired: false }
      } catch (error) {
        options.log.warn(
          `schedules: ${plugin.id}/${payload.key} failed: ${error instanceof Error ? error.message : error}`,
        )
        audit(`plugin.${plugin.id}.schedule.failed`, { key: payload.key, scheduledAt })
        return { fired: false }
      }
    },
  })

  const portFor = (pluginId: string): PluginSchedule => ({
    async set(key, input) {
      if (!SCHEDULE_KEY.test(key)) throw new OperationError('INVALID_INPUT', 'bad schedule key')
      const data = input.payload ?? null
      if (JSON.stringify(data).length > SCHEDULE_PAYLOAD_MAX)
        throw new OperationError('INVALID_INPUT', 'schedule payload is too large')
      if (input.when.kind === 'cron') {
        const first = nextCron(input.when.expr, now())
        const second = first === undefined ? undefined : nextCron(input.when.expr, first)
        if (first === undefined) throw new OperationError('INVALID_INPUT', 'bad cron expression')
        if (second !== undefined && second - first < MIN_CRON_GAP_MS)
          throw new OperationError(
            'INVALID_INPUT',
            'a repeating reminder is at most every 15 minutes',
          )
      } else if (!Number.isFinite(input.when.at)) {
        throw new OperationError('INVALID_INPUT', 'bad time')
      }
      const id = idOf(pluginId, key)
      await scheduler.remove(id)
      const row = await scheduler.create({
        id,
        sessionId: sessionOf(pluginId),
        spec:
          input.when.kind === 'cron'
            ? { kind: 'cron', expr: input.when.expr }
            : { kind: 'once', at: input.when.at },
        catchUp: input.catchUp,
        overlap: 'skip',
        payload: { plugin: pluginId, key, data } satisfies Payload,
      })
      return infoOf(row)
    },
    async get(key) {
      const row = await scheduler.store.get(idOf(pluginId, key))
      return row === undefined ? undefined : infoOf(row)
    },
    cancel: (key) => scheduler.remove(idOf(pluginId, key)),
  })

  // the slots declined while a plugin was off: each one replayed once, late, then dropped from the store
  const replayDeclined = async (): Promise<void> => {
    for (const plugin of options.plugins()) {
      if (plugin.manifest.onSchedule === undefined) continue
      for (const slot of catchup.get(plugin.id)) {
        const row = await scheduler.store.get(idOf(plugin.id, slot.key))
        if (row !== undefined) {
          try {
            await plugin.manifest.onSchedule(
              {
                key: slot.key,
                scheduledAt: slot.scheduledAt,
                fireId: slot.fireId,
                payload: (row.payload as Payload).data,
                late: true,
              },
              fireCtx(plugin),
            )
          } catch (error) {
            options.log.warn(
              `schedules: ${plugin.id}/${slot.key} replay failed: ${error instanceof Error ? error.message : error}`,
            )
            audit(`plugin.${plugin.id}.schedule.failed`, {
              key: slot.key,
              scheduledAt: slot.scheduledAt,
            })
          }
        }
        // the slot is handled (or its timer was cancelled while the plugin was off): drop it
        catchup.set(
          plugin.id,
          catchup.get(plugin.id).filter((s) => s.key !== slot.key),
        )
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<unknown> | undefined
  const tick = async (): Promise<TickReport> => {
    const report = await scheduler.tick()
    for (const s of report.skipped) {
      // `declined` is the plugin's own decision (it audits why); the others are slots the catch-up rule dropped
      if (s.reason === 'declined') continue
      const row = await scheduler.store.get(s.scheduleId)
      const payload = row?.payload as Payload | undefined
      audit(`plugin.${payload?.plugin ?? 'unknown'}.schedule.skipped`, {
        key: payload?.key ?? s.scheduleId,
        scheduledAt: s.scheduledAt,
        reason: s.reason,
      })
    }
    return report
  }
  return {
    port: {
      set: (pluginId, key, input) => portFor(pluginId).set(key, input),
      get: (pluginId, key) => portFor(pluginId).get(key),
      cancel: (pluginId, key) => portFor(pluginId).cancel(key),
    },
    async start() {
      if (timer !== undefined) return
      await tick().catch((error) =>
        options.log.warn(
          `schedules: first tick failed: ${error instanceof Error ? error.message : error}`,
        ),
      )
      await replayDeclined().catch((error) =>
        options.log.warn(
          `schedules: replay failed: ${error instanceof Error ? error.message : error}`,
        ),
      )
      timer = setInterval(() => {
        running = tick().catch((error) =>
          options.log.warn(
            `schedules: tick failed: ${error instanceof Error ? error.message : error}`,
          ),
        )
      }, options.tickMs ?? 15_000)
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await running
      await scheduler.stop()
    },
    tick,
  }
}
