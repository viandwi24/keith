import { Database } from 'bun:sqlite'
import { defineKinds, type KindDef, type MemoryAcl, memoryAcl } from '@keith/acl'
import { capabilitiesOf, type PersonRole } from '@keith/contracts'
import { readContributions } from '../contributions.ts'
import {
  type ActorDirectory,
  type ActorFacts,
  createGuard,
  type Guard,
  type GuardCall,
} from '../guard.ts'
import type { ScheduleFireCtx } from '../schedule.ts'
import { type BootPlan, createServiceRegistry, planBoot } from '../services.ts'
import { createPluginStorage, migratePluginStorage, pluginsWithStorage } from '../storage/index.ts'
import type { KeithPlugin, PluginEvent, SessionFacts } from '../types.ts'
import {
  type FakeClock,
  fakeActor,
  fakeClock,
  fakeGuest,
  frontSession,
  type RecordingAudit,
  recordingAudit,
} from './fakes.ts'
import { memoryAccess, memoryProtocols, memorySchedules, recordingWake } from './memory-extras.ts'

interface Person {
  role: PersonRole
  status: 'active' | 'suspended'
  grants: Set<string>
  revoked: Set<string>
}

export interface MemoryHost {
  guard: Guard
  acl: MemoryAcl
  clock: FakeClock
  audit: RecordingAudit
  directory: ActorDirectory
  /** The in-memory database behind `k.db` and `k.kv` (the plugins' migrations applied, plus the core's `plugin_kv`). */
  sqlite: Database
  /** Typed events the plugins emitted, in order (what the feed would receive; `to` as given). */
  events: PluginEvent[]
  /** The review queue: what the guard stored (`status` moves with `approve` and `deny`). */
  reviews: Array<{
    id: string
    requester: string
    plugin: string
    operation: string
    payload: unknown
    status: 'pending' | 'approved' | 'denied'
  }>
  /** Replays a pending review the way the core does on approval: as the requester, revalidated, never elevated. */
  approve(id: string): Promise<unknown>
  deny(id: string): void
  /** Notices `k.notify` sent: `{ plugin, to, text }`. */
  notices: Array<{ plugin: string; to: string; text: string }>
  /**
   * Boots the plugins like the core does: dependency order (`planBoot`), then each `start` with `provide`,
   * `services`, `emit` and `contributions`. Throws when a plugin cannot boot. Call it before `call` when a plugin has a `start`
   * or `requires`; plugins without either need not boot.
   */
  boot(): Promise<void>
  /** What `ctx.wake` was asked, in order; set `wake.result` to `{ delivered: false, reason: 'budget' }` to simulate an empty budget. */
  wake: ReturnType<typeof recordingWake>
  /** The timers plugins set (`k.schedule`), by `<plugin>:<key>`. */
  schedules: ReturnType<typeof memorySchedules>['rows']
  /** The timed protocols plugins set (`k.protocols`), by `<plugin>:<owner>:<key>`; `endRun` ends one run (calls `onRunEnd`). */
  protocols: {
    rows: ReturnType<typeof memoryProtocols>['rows']
    endRun: ReturnType<typeof memoryProtocols>['endRun']
    port: ReturnType<typeof memoryProtocols>['port']
  }
  /**
   * Fires every timer that is due on the fake clock through the plugin's `onSchedule` (a slot older than 30 s is `late`),
   * then advances it: a `once` timer is done, a cron timer moves to its next slot after now.
   */
  tick(): Promise<void>
  /** Adds an active person (also active in the ACL). */
  add(id: string, role?: PersonRole): void
  suspend(id: string): void
  remove(id: string): void
  restore(id: string): void
  grant(id: string, capability: string): void
  /** Takes a capability away from one person (even one their role gives): what a fire re-checks. */
  revoke(id: string, capability: string): void
  /** Adds a guest (P17): they hold no capability and pass only a `public` audience. */
  addGuest(id: string): void
  /** `guard.run` for an operation of a plugin, as `personId` (or no principal when undefined). */
  call(
    plugin: KeithPlugin | string,
    operation: string,
    input: unknown,
    personId: string | undefined,
    session?: Partial<SessionFacts>,
  ): Promise<unknown>
  plugin(id: string): KeithPlugin
}

/**
 * The host without the core: an in-memory people directory, the in-memory ACL (kinds of the plugins
 * registered), a recording audit and a fake clock behind the real guard. A plugin's tests use this.
 */
export function memoryHost(options: { plugins: readonly KeithPlugin[] }): MemoryHost {
  const clock = fakeClock()
  const audit = recordingAudit()
  const defs: Record<string, KindDef> = {}
  for (const p of options.plugins) Object.assign(defs, p.manifest.resources ?? {})
  const acl = memoryAcl({ kinds: defineKinds(defs), now: clock.now })
  const people = new Map<string, Person>()
  const guests = new Set<string>()
  const defaults = (role: PersonRole): string[] =>
    options.plugins.flatMap((p) =>
      (p.manifest.permissions ?? [])
        .filter((perm) => role === 'owner' || (perm.roles ?? []).includes(role))
        .map((perm) => perm.id),
    )

  const directory: ActorDirectory = {
    resolve(id): ActorFacts | undefined {
      if (guests.has(id)) return { actor: fakeGuest(id), status: 'active', capabilities: new Set() }
      const p = people.get(id)
      if (p === undefined) return undefined
      const capabilities = new Set<string>([
        ...capabilitiesOf(p.role),
        ...defaults(p.role),
        ...p.grants,
      ])
      for (const c of p.revoked) capabilities.delete(c)
      return {
        actor: fakeActor({ personId: id, principalId: id, role: p.role }),
        status: p.status,
        capabilities,
      }
    },
  }
  const plugins = new Map(options.plugins.map((p) => [p.id, p]))
  // storage: the plugins' own migrations on an in-memory database, plus the core's `plugin_kv` table
  const sqlite = new Database(':memory:', { strict: true })
  sqlite.exec(
    'CREATE TABLE plugin_kv (plugin text NOT NULL, key text NOT NULL, value text NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (plugin, key))',
  )
  migratePluginStorage(sqlite, pluginsWithStorage(options.plugins))
  const events: PluginEvent[] = []
  const notices: Array<{ plugin: string; to: string; text: string }> = []
  const registry = createServiceRegistry()
  // set by `boot`: the contributions the plugins read (`ctx.contributions`, `k.contributions`)
  let plan: BootPlan | undefined
  const contributionsOf = (point: string) => plan?.contributions.get(point) ?? []
  const reviews: MemoryHost['reviews'] = []
  const sched = memorySchedules(clock)
  const protos = memoryProtocols(clock)
  const wake = recordingWake()
  const kinds = defineKinds(defs)
  const access = memoryAccess({
    acl,
    kinds,
    audit,
    role: (id) => people.get(id)?.role,
    isActive: (id) => people.get(id)?.status === 'active',
  })
  const guard = createGuard({
    schedule: sched.port,
    protocols: protos.port,
    access,
    people: {
      async find(query) {
        const id = query.trim().toLowerCase().replace(/^@/, '')
        const p = people.get(id)
        return p?.status === 'active' ? { id, name: id, username: id } : undefined
      },
      async name(id) {
        return people.has(id) ? id : undefined
      },
    },
    ownerAccess: (caller, access) =>
      audit.record({
        kind: 'acl.owner-access',
        actor: caller.by,
        via: caller.via,
        detail: {
          kind: access.kind,
          ids: access.resources.map((r) => r.id),
          count: access.resources.length,
          owner: access.resources[0]?.owner,
          bits: access.bits,
        },
      }),
    plugin: (id) => plugins.get(id),
    services: (plugin) => registry.viewFor(plugin),
    contributions: (_pluginId, point) => contributionsOf(point),
    events: { publish: (e) => void events.push(e) },
    notices: { notify: (n) => void notices.push(n) },
    reviews: {
      request(r) {
        const pending = reviews.filter((x) => x.requester === r.requester && x.status === 'pending')
        if (pending.length >= 20) return { ok: false, reason: 'cap' }
        const id = `rv${reviews.length + 1}`
        reviews.push({ id, ...r, status: 'pending' })
        return { ok: true, id }
      },
    },
    directory,
    acl,
    audit,
    clock,
    storage: createPluginStorage(sqlite, clock),
    // the in-memory ACL does not roll back: atomicity is tested over the core's SQLite ACL (plugins/notes atomic test)
    transaction: (fn) => sqlite.transaction(fn).immediate(),
  })
  const status = (id: string, next: Person['status']): void => {
    const p = people.get(id)
    if (p !== undefined) p.status = next
    if (next === 'active') acl.activate(id)
    else acl.deactivate(id)
  }
  return {
    guard,
    acl,
    clock,
    audit,
    directory,
    sqlite,
    events,
    notices,
    reviews,
    async approve(id) {
      const r = reviews.find((x) => x.id === id && x.status === 'pending')
      if (r === undefined) throw new Error('no pending review')
      r.status = 'approved'
      const op = plugins.get(r.plugin)?.operation(r.operation)
      if (op === undefined) throw new Error('no operation')
      return guard.run(op, r.payload, {
        principal: { id: r.requester },
        session: frontSession({ id: null, kind: 'api' }),
        approvedReview: id,
      })
    },
    deny(id) {
      const r = reviews.find((x) => x.id === id)
      if (r !== undefined) r.status = 'denied'
    },
    wake,
    schedules: sched.rows,
    protocols: { rows: protos.rows, endRun: protos.endRun, port: protos.port },
    async tick() {
      for (const row of [...sched.rows.values()]) {
        if (row.nextFireAt === null || row.nextFireAt > clock.now()) continue
        const plugin = plugins.get(row.plugin)
        const storage = createPluginStorage(sqlite, clock)(row.plugin)
        const ctx: ScheduleFireCtx = {
          plugin: { id: row.plugin },
          clock,
          db: storage.db,
          kv: storage.kv,
          acl,
          schedule: {
            set: (key, input) => sched.port.set(row.plugin, key, input),
            get: (key) => sched.port.get(row.plugin, key),
            cancel: (key) => sched.port.cancel(row.plugin, key),
          },
          async person(personId) {
            const facts = directory.resolve(personId)
            const f = facts instanceof Promise ? await facts : facts
            if (f === undefined) return undefined
            return {
              id: personId,
              name: personId,
              active: f.status === 'active',
              role: f.actor.role ?? 'member',
              has: (c) => f.capabilities.has(c),
            }
          },
          wake: (request) => wake.deliver(row.plugin, request),
          audit: {
            record: (kind, detail, actor) =>
              audit.record({
                kind: `plugin.${row.plugin}.${kind}`,
                actor: actor ?? 'system',
                via: 'local',
                detail: { ...(detail ?? {}) },
              }),
          },
        }
        const at = row.nextFireAt
        await plugin?.manifest.onSchedule?.(
          {
            key: row.key,
            scheduledAt: at,
            fireId: `sched:${row.plugin}:${row.key}:${at}`,
            payload: row.payload,
            late: clock.now() - at > 30_000,
          },
          ctx,
        )
        row.lastFireAt = at
        row.nextFireAt =
          row.when.kind === 'once'
            ? null
            : (Bun.cron.parse(row.when.expr, new Date(clock.now()))?.getTime() ?? null)
      }
    },
    async boot() {
      const next = planBoot(options.plugins, () => true)
      if (next.failed.size > 0)
        throw new Error(
          [...next.failed].map(([id, reason]) => `plugin ${id}: ${reason}`).join('; '),
        )
      plan = next
      const abort = new AbortController()
      for (const plugin of next.order) {
        await plugin.manifest.start?.({
          id: plugin.id,
          config: {},
          acl,
          clock,
          log: { info() {}, warn() {} },
          signal: abort.signal,
          provide: (serviceId, impl) => registry.provide(plugin, serviceId, impl),
          services: registry.viewFor(plugin),
          emit: (name, data, to) => guard.publisher.emit(plugin, name, data, to),
          contributions: (point) => readContributions(plugin, point, contributionsOf),
        })
        const missing = registry.missing(plugin)
        if (missing.length > 0)
          throw new Error(`plugin ${plugin.id}: did not provide ${missing.join(', ')}`)
      }
    },
    add(id, role = 'member') {
      people.set(id, { role, status: 'active', grants: new Set(), revoked: new Set() })
      acl.activate(id)
    },
    suspend: (id) => status(id, 'suspended'),
    remove(id) {
      people.delete(id)
      acl.deactivate(id)
    },
    restore: (id) => status(id, 'active'),
    grant: (id, capability) => void people.get(id)?.grants.add(capability),
    revoke: (id, capability) => void people.get(id)?.revoked.add(capability),
    addGuest: (id) => void guests.add(id),
    call(plugin, operation, input, personId, session = {}) {
      const p = typeof plugin === 'string' ? plugins.get(plugin) : plugin
      const op = p?.operation(operation)
      if (op === undefined) throw new Error(`no operation ${String(operation)}`)
      const call: GuardCall = {
        principal: personId === undefined ? undefined : { id: personId },
        session: frontSession({
          id: personId === undefined ? null : `front:${personId}`,
          ...session,
        }),
      }
      return guard.run(op, input, call)
    },
    plugin(id) {
      const p = plugins.get(id)
      if (p === undefined) throw new Error(`no plugin ${id}`)
      return p
    },
  }
}
