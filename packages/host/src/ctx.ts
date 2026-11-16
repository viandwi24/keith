import { aclActorOf } from '@keith/acl'
import type { Actor } from '@keith/contracts'
import type { PluginAccess, PluginPeople } from './access.ts'
import { auditedAcl } from './acl-audited.ts'
import { readContributions } from './contributions.ts'
import { GuardError, OperationError } from './errors.ts'
import type { Publisher } from './events.ts'
import type { ActorFacts, Guard, GuardCall, GuardDeps } from './guard.ts'
import { checkProtocolTime, type PluginProtocols, type ProtocolCaller } from './protocols.ts'
import type { PluginSchedule } from './schedule.ts'
import type {
  KeithCtx,
  KeithPlugin,
  PluginStorage,
  ResolvedOperation,
  ReviewTicket,
} from './types.ts'

/** Deepest chain of `k.call`: operation A calls B calls C calls D. A fifth link is refused. */
export const MAX_CALL_DEPTH = 4

const NEVER_ABORTED = new AbortController().signal

/**
 * The context of one execute call. It is built here, for this call's actor and session facts, and
 * handed to `run`; nothing keeps it afterwards, so it cannot go stale (docs/specs/plugins.md, "Context").
 */
export function buildCtx(
  deps: GuardDeps,
  op: ResolvedOperation,
  actor: Actor,
  facts: ActorFacts,
  call: GuardCall,
  publisher: Publisher,
  run: Guard['run'],
  requestReview: (
    op: ResolvedOperation,
    input: unknown,
    reason: string | undefined,
  ) => ReviewTicket,
): KeithCtx {
  const who =
    actor.kind === 'user' && actor.personId !== null ? actor.personId : `guest:${actor.principalId}`
  const plugin = (): KeithPlugin => {
    const found = deps.plugin?.(op.pluginId)
    if (found === undefined) throw new Error('plugin is not available')
    return found
  }
  const storage = (): PluginStorage => {
    if (deps.storage === undefined) throw new Error('plugin storage is not available')
    return deps.storage(op.pluginId)
  }
  return Object.freeze({
    actor,
    // a guest is never elevated, whatever the caller of the guard says
    session: Object.freeze({
      ...call.session,
      ...(actor.kind === 'guest' ? { elevated: false } : {}),
    }),
    plugin: Object.freeze({ id: op.pluginId, operation: op.name }),
    acl: auditedAcl(deps.acl, deps.aclWrites, () =>
      actor.kind === 'user' && actor.personId !== null
        ? { by: who, via: actor.via, session: call.session.id }
        : null,
    ),
    aclActor: aclActorOf(actor),
    caps: {
      has: (capability: string) =>
        capability === 'authenticated' || facts.capabilities.has(capability),
    },
    audit: {
      ownerAccess(kind: string, ids: readonly string[]) {
        if (actor.role !== 'owner' || who === undefined || ids.length === 0) return
        if (deps.ownerAccess === undefined) return
        const me = aclActorOf(actor)
        if (me === undefined) return
        const resources: { id: string; owner: string }[] = []
        for (const id of ids) {
          const res = deps.acl.getResource(kind, id)
          if (res === undefined || res.ownerId === who) continue
          if (deps.acl.check(me, kind, id, 4).ownerAccess)
            resources.push({ id, owner: res.ownerId })
        }
        if (resources.length === 0) return
        try {
          deps.ownerAccess({ by: who, via: actor.via }, { kind, bits: 4, resources })
        } catch (error) {
          deps.log?.warn(`plugins: audit failed: ${error instanceof Error ? error.message : error}`)
        }
      },
      record(kind: string, detail?: Record<string, unknown>) {
        try {
          deps.audit.record({
            kind: `plugin.${op.pluginId}.${kind}`,
            actor: who,
            via: actor.via,
            detail: { ...(detail ?? {}) },
          })
        } catch (error) {
          deps.log?.warn(`plugins: audit failed: ${error instanceof Error ? error.message : error}`)
        }
      },
    },
    clock: deps.clock,
    config: deps.config?.(op.pluginId) ?? {},
    signal: call.signal ?? NEVER_ABORTED,
    get db() {
      return storage().db
    },
    get kv() {
      return storage().kv
    },
    transaction<T>(fn: () => T): T {
      if (deps.transaction === undefined) throw new Error('transactions are not available')
      return deps.transaction(fn)
    },
    get services() {
      const plugin = deps.plugin?.(op.pluginId)
      if (plugin === undefined || deps.services === undefined)
        throw new Error('plugin services are not available')
      return deps.services(plugin)
    },
    async call(target: string, input: unknown) {
      const depth = (call.depth ?? 0) + 1
      if (depth > MAX_CALL_DEPTH) throw new OperationError('CONFLICT', 'calls are nested too deep')
      const dot = target.indexOf('.')
      const callee =
        dot < 1 ? undefined : deps.plugin?.(target.slice(0, dot))?.operation(target.slice(dot + 1))
      if (callee === undefined || !callee.expose.call) throw new GuardError('NOT_FOUND', 'call')
      return run(callee, input, {
        principal: call.principal,
        session: call.session,
        depth,
        caller: `${op.pluginId}.${op.name}`,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      })
    },
    review: {
      request(operation: string, input: unknown, reason?: string) {
        if (actor.role === 'owner')
          throw new OperationError('CONFLICT', 'the owner needs no review: run it')
        const target = deps.plugin?.(op.pluginId)?.operation(operation)
        if (target === undefined)
          throw new Error(`review: no operation "${operation}" in this plugin`)
        const parsed = target.input.safeParse(input)
        if (!parsed.success)
          throw new GuardError('INVALID_INPUT', 'input', 'the request is not valid')
        return requestReview(target, parsed.data, reason)
      },
    },
    get schedule(): PluginSchedule {
      const port = deps.schedule
      if (port === undefined || plugin().manifest.onSchedule === undefined)
        throw new Error('plugin schedules are not available (declare onSchedule)')
      return {
        set: (key, input) => port.set(op.pluginId, key, input),
        get: (key) => port.get(op.pluginId, key),
        cancel: (key) => port.cancel(op.pluginId, key),
      }
    },
    get people(): PluginPeople {
      // a guest learns no name and finds no person
      if (actor.kind === 'guest')
        return { find: async () => undefined, name: async () => undefined }
      const port = deps.people
      if (port === undefined) throw new Error('plugin people are not available')
      return { find: (query) => port.find(query), name: (id) => port.name(id) }
    },
    get protocols(): PluginProtocols {
      const port = deps.protocols
      if (port === undefined) throw new Error('plugin protocols are not available')
      // a guest and a system actor have no person to set a protocol for: the refusal is the same for both
      const caller = (): ProtocolCaller => {
        if (actor.kind !== 'user' || actor.personId === null || actor.role === null)
          throw new OperationError('FORBIDDEN', 'only a person can set a protocol')
        return {
          personId: actor.personId,
          role: actor.role,
          capabilities: facts.capabilities,
          via: actor.via,
        }
      }
      return {
        upsertTime(input) {
          checkProtocolTime(input)
          return port.upsertTime(op.pluginId, caller(), input)
        },
        cancel(key, owner) {
          return port.cancel(op.pluginId, caller(), key, owner)
        },
      }
    },
    get access(): PluginAccess {
      // a guest changes nobody's access: every call is the one refusal
      if (actor.kind === 'guest') {
        const refuse = (): never => {
          throw new GuardError('NOT_FOUND', 'access')
        }
        return { show: refuse, share: refuse, unshare: refuse }
      }
      const port = deps.access
      if (port === undefined) throw new Error('plugin access is not available')
      const kinds = Object.keys(plugin().manifest.resources ?? {})
      const caller = {
        by: who,
        via: actor.via,
        confirmed: call.session.elevated,
        session: call.session.id,
      }
      const own = (kind: string): string => {
        if (!kinds.includes(kind)) throw new GuardError('NOT_FOUND', 'access')
        return kind
      }
      return {
        show: (kind, id) => port.show(caller, { kind: own(kind), id }),
        share: (input) => port.share(caller, { ...input, kind: own(input.kind) }),
        unshare: (input) => port.unshare(caller, { ...input, kind: own(input.kind) }),
      }
    },
    contributions(point: string) {
      const source = deps.contributions
      return readContributions(
        plugin(),
        point,
        source === undefined ? undefined : (p) => source(op.pluginId, p),
      )
    },
    notify(text: string) {
      if (actor.kind !== 'user' || actor.personId === null)
        throw new Error('notify: only a person can be told')
      publisher.notify(plugin(), actor.personId, text)
    },
    emit(name: string, data: unknown, to?: readonly string[] | 'public') {
      const target =
        to ?? (actor.kind === 'user' && actor.personId !== null ? [actor.personId] : [])
      publisher.emit(plugin(), name, data, target)
    },
  })
}
