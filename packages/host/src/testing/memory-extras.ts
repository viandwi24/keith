import { entryProblem, type KindRegistry, type MemoryAcl } from '@keith/acl'
import { type AclView, type Entry, formatMode, type Resource, type Subject } from '@keith/contracts'
import type { AccessPort } from '../access.ts'
import { GuardError, OperationError } from '../errors.ts'
import type { ProtocolCaller, ProtocolRunEnd, ProtocolsPort } from '../protocols.ts'
import type {
  ScheduleInfo,
  SchedulePort,
  ScheduleWhen,
  WakePort,
  WakeRequest,
  WakeResult,
} from '../schedule.ts'
import type { AuditPort } from '../types.ts'

/**
 * The access service in memory, with the rules of the core's (`acl.md`, "Changing access"): only the resource's
 * owner (or the instance owner) changes it, a user target must be an active person, a group must exist,
 * widening to `@users` or `@public` needs a confirmed call, `NOT_FOUND` is one answer for a missing and a denied resource.
 */
export function memoryAccess(options: {
  acl: MemoryAcl
  kinds: KindRegistry
  audit: AuditPort
  role(personId: string): 'owner' | 'member' | undefined
  isActive(personId: string): boolean
}): AccessPort {
  const { acl, kinds } = options
  const view = (res: Resource): AclView => ({
    kind: res.kind,
    id: res.id,
    owner: { id: res.ownerId, label: res.ownerId },
    group: res.groupId === null ? null : { id: res.groupId, label: res.groupId },
    mode: res.mode,
    modeText: formatMode(res.mode),
    entries: res.entries.map((e) => ({ ...e, label: e.subject })),
    createdAt: res.createdAt,
    updatedAt: res.updatedAt,
  })
  const target = (raw: string): Subject => {
    if (raw === '@users' || raw === '@public') return raw
    const m = /^(user|group):(.+)$/.exec(raw)
    if (m?.[1] === undefined || m[2] === undefined)
      throw new OperationError(
        'INVALID_INPUT',
        'a target is user:<id>, group:<name>, @users or @public',
      )
    if (m[1] === 'user') {
      if (!options.isActive(m[2]))
        throw new OperationError('INVALID_INPUT', 'unknown or inactive user')
      return `user:${m[2]}`
    }
    const g = acl.listGroups().find((x) => x.id === m[2] || x.name === m[2])
    if (g === undefined) throw new OperationError('INVALID_INPUT', 'unknown group')
    return `group:${g.id}`
  }
  const own = (by: string, kind: string, id: string): Resource => {
    const res = acl.getResource(kind, id)
    const def = kinds.get(kind)
    const role = options.role(by)
    if (res === undefined || def === undefined || !options.isActive(by))
      throw new GuardError('NOT_FOUND', 'access')
    if (role !== 'owner' && res.ownerId !== by) {
      const readable = acl.check(
        { kind: 'user', id: by, role: role ?? 'member' },
        kind,
        id,
        4,
      ).allowed
      if (readable)
        throw new OperationError(
          'FORBIDDEN',
          'only the owner of the resource may change who can access it',
        )
      throw new GuardError('NOT_FOUND', 'access')
    }
    return res
  }
  const record = (kind: string, by: string, detail: Record<string, unknown>): void =>
    options.audit.record({ kind, actor: by, via: 'local', detail })
  return {
    async show(caller, ref) {
      return view(own(caller.by, ref.kind, ref.id))
    },
    async share(caller, input) {
      const res = own(caller.by, input.kind, input.id)
      const effect = input.effect ?? 'allow'
      const subject = target(input.target)
      const entry: Entry = { subject, bits: input.bits, effect }
      const def = kinds.get(input.kind)
      const problem = def === undefined ? 'bad kind' : entryProblem(def.class, entry)
      if (problem !== undefined) throw new OperationError('INVALID_INPUT', problem)
      const had = res.entries.find((e) => e.subject === subject && e.effect === effect)?.bits ?? 0
      if (
        effect === 'allow' &&
        (subject === '@users' || subject === '@public') &&
        (input.bits & ~had) !== 0 &&
        !caller.confirmed
      )
        throw new OperationError(
          'FORBIDDEN',
          'widening access to everyone needs a confirmation (step-up with your PIN or password)',
        )
      const after = acl.setEntry(input.kind, input.id, entry, caller.by)
      if (after === undefined) throw new GuardError('NOT_FOUND', 'access')
      record('acl.share', caller.by, {
        kind: input.kind,
        id: input.id,
        subject,
        bits: input.bits,
        effect,
      })
      return view(after)
    },
    async unshare(caller, input) {
      const res = own(caller.by, input.kind, input.id)
      const effect = input.effect ?? 'allow'
      const subject = target(input.target)
      if (res.entries.some((e) => e.subject === subject && e.effect === effect)) {
        acl.removeEntry(input.kind, input.id, subject, effect)
        record('acl.unshare', caller.by, { kind: input.kind, id: input.id, subject, effect })
      }
      return view(acl.getResource(input.kind, input.id) as Resource)
    },
  }
}

export interface MemorySchedule {
  plugin: string
  key: string
  when: ScheduleWhen
  catchUp: unknown
  payload: unknown
  nextFireAt: number | null
  lastFireAt: number | null
}

/** Timers in memory, run by hand (`tick`) against the fake clock; once and cron, no leases. */
export function memorySchedules(clock: { now(): number }): {
  port: SchedulePort
  rows: Map<string, MemorySchedule>
} {
  const rows = new Map<string, MemorySchedule>()
  const info = (r: MemorySchedule): ScheduleInfo => ({
    key: r.key,
    when: r.when,
    nextFireAt: r.nextFireAt,
    lastFireAt: r.lastFireAt,
  })
  const next = (when: ScheduleWhen, after: number): number | null => {
    if (when.kind === 'once') return when.at
    const n = Bun.cron.parse(when.expr, new Date(after))
    return n === null ? null : n.getTime()
  }
  return {
    rows,
    port: {
      async set(plugin, key, input) {
        const row: MemorySchedule = {
          plugin,
          key,
          when: input.when,
          catchUp: input.catchUp,
          payload: input.payload ?? null,
          nextFireAt: next(input.when, clock.now()),
          lastFireAt: null,
        }
        rows.set(`${plugin}:${key}`, row)
        return info(row)
      },
      async get(plugin, key) {
        const r = rows.get(`${plugin}:${key}`)
        return r === undefined ? undefined : info(r)
      },
      async cancel(plugin, key) {
        return rows.delete(`${plugin}:${key}`)
      },
    },
  }
}

/** A wake port that records what it was asked and answers `result` (change it to simulate an empty budget). */
export function recordingWake(): WakePort & {
  requests: Array<WakeRequest & { plugin: string }>
  result: WakeResult
} {
  const wake = {
    requests: [] as Array<WakeRequest & { plugin: string }>,
    result: { delivered: true } as WakeResult,
    async deliver(plugin: string, request: WakeRequest) {
      wake.requests.push({ plugin, ...request })
      return wake.result
    },
  }
  return wake
}

/** One timed protocol the memory double stored (what the core would hold as a protocol with a time trigger). */
export interface MemoryProtocol {
  id: string
  plugin: string
  key: string
  owner: string
  when: ScheduleWhen
  step: 'notify' | 'wake'
  to: string
  text: string
  nextFireAt: number | null
}

/**
 * The protocol port in memory (docs/specs/plugins/reminders.md, "Internals"). It keeps what `upsertTime` and `cancel` were
 * given and applies the authoring rule the core applies (a step to another person is the owner's only). Runs are not
 * engine runs: `endRun` stands for one reaching an end state and calls the `onRunEnd` handlers of the plugin.
 */
export function memoryProtocols(clock: { now(): number }): {
  port: ProtocolsPort
  rows: Map<string, MemoryProtocol>
  endRun(plugin: string, key: string, runId: string, status: string): void
} {
  const rows = new Map<string, MemoryProtocol>()
  const handlers = new Map<string, Set<(end: ProtocolRunEnd) => void>>()
  const next = (when: ScheduleWhen, after: number): number | null => {
    if (when.kind === 'once') return when.at
    const n = Bun.cron.parse(when.expr, new Date(after))
    return n === null ? null : n.getTime()
  }
  const mine = (caller: ProtocolCaller, owner: string): boolean =>
    caller.role === 'owner' || caller.personId === owner
  return {
    rows,
    port: {
      async upsertTime(plugin, caller, input) {
        if (!mine(caller, input.owner))
          throw new OperationError('FORBIDDEN', 'a protocol is set for its own person')
        const to = input.to ?? input.owner
        // the authoring rule of the core: a person-owned protocol messages only its owner, the owner role included
        if (to !== input.owner)
          throw new OperationError('FORBIDDEN', 'a person-owned protocol may notify only its owner')
        const id = `prot:${plugin}:${input.owner}:${input.key}`
        const row: MemoryProtocol = {
          id,
          plugin,
          key: input.key,
          owner: input.owner,
          when: input.when,
          step: input.step,
          to,
          text: input.text,
          nextFireAt: next(input.when, clock.now()),
        }
        rows.set(`${plugin}:${input.owner}:${input.key}`, row)
        return { key: input.key, protocolId: id, nextFireAt: row.nextFireAt }
      },
      async cancel(plugin, caller, key, owner) {
        if (!mine(caller, owner)) return false
        return rows.delete(`${plugin}:${owner}:${key}`)
      },
      onRunEnd(plugin, handler) {
        const set = handlers.get(plugin) ?? new Set()
        set.add(handler)
        handlers.set(plugin, set)
        return () => void set.delete(handler)
      },
    },
    endRun(plugin, key, runId, status) {
      const row = [...rows.values()].find((r) => r.plugin === plugin && r.key === key)
      if (row === undefined) return
      for (const handler of handlers.get(plugin) ?? [])
        handler({ plugin, key, runId, owner: row.owner, status })
    },
  }
}
