// The protocol port of plugins (docs/specs/plugins/reminders.md, "Internals"; P28.6.1): the core's implementation of
// `ProtocolsPort` from `@keith/host`, an adapter over the protocol service. A plugin's timed protocol is a protocol of the
// person it belongs to (the owner is the creator, never `keith`), named `<plugin>:<key>`, with one time trigger and one
// `notify` or `wake` step. It is authored by the caller through the same authoring function as every other protocol, so
// a step to another person is the owner role's alone. Nothing here reads the engine: runs reach the plugins through
// `runEnded`, which the journal calls at each `brain.hypothalamus.end`.
import type { PersonRole, ProtocolDefinition } from '@keith/contracts'
import type { ProtocolRunsRepo, ProtocolsRepo } from '@keith/db'
import {
  type ProtocolCaller as HostCaller,
  OperationError,
  type ProtocolRunEnd,
  type ProtocolsPort,
  type ProtocolTimeInfo,
  type ProtocolTimeInput,
} from '@keith/host'
import { KEITH_OWNER } from './authoring.ts'
import type { ProtocolCaller, ProtocolService } from './service.ts'
import { nextCronSlot } from './triggers.ts'
import { ProtocolError } from './views.ts'

/** The port the composition hands to the plugins before the service exists: it forwards to the bound implementation. */
export interface DelegatingProtocolsPort {
  readonly port: ProtocolsPort
  /** Binds the implementation (once the service is wired); calls made before it are refused. */
  bind(impl: ProtocolHostPort): void
  /** A run of a protocol reached an end state: the plugin that owns it is told (no-op for other protocols). */
  runEnded(runId: string, status: string): Promise<void>
}

/** The core's implementation: the port, plus the run-end report the journal drives. */
export interface ProtocolHostPort extends ProtocolsPort {
  runEnded(runId: string, status: string): Promise<void>
}

export interface ProtocolHostPortDeps {
  service: Pick<ProtocolService, 'save' | 'remove'>
  protocols: ProtocolsRepo
  runs: Pick<ProtocolRunsRepo, 'get'>
  /** Epoch ms; the next slot of a cron protocol is read from it. */
  now(): number
}

/** The protocol limits a plugin's timed protocol gets: the defaults of the contract (one run a day, a small budget). */
const LIMITS = { maxRunsPerDay: 3, budgetUsdPerRun: 0.05, maxSteps: 100, maxVisits: 30 } as const

/** The name of a plugin's protocol: the plugin id, a colon, the key. */
export const hostNameOf = (plugin: string, key: string): string => `${plugin}:${key}`

/** The authoring caller of a plugin call: the host's facts, in the shape the service reads. */
function callerOf(caller: HostCaller): ProtocolCaller {
  return {
    id: caller.personId,
    role: caller.role as PersonRole,
    capabilities: caller.capabilities,
    via: caller.via,
  }
}

/** The definition of one timed protocol: one time trigger, one fixed step, the contract's defaults. */
export function definitionOf(input: ProtocolTimeInput): ProtocolDefinition {
  const to = input.to ?? input.owner
  const trigger =
    input.when.kind === 'once'
      ? { kind: 'time' as const, at: input.when.at }
      : { kind: 'time' as const, cron: input.when.expr }
  const step =
    input.step === 'notify'
      ? { id: 'remind', kind: 'notify' as const, to, text: input.text }
      : { id: 'remind', kind: 'wake' as const, to, instruction: input.text }
  return { trigger, conditions: [], steps: [step], limits: { ...LIMITS }, start: 'remind' }
}

/** A refusal of the service as the host's operation error (the guard maps the code to the caller). */
function asOperationError(error: unknown): unknown {
  if (!(error instanceof ProtocolError)) return error
  switch (error.code) {
    case 'BAD_REQUEST':
      return new OperationError('INVALID_INPUT', error.message)
    case 'FORBIDDEN':
      return new OperationError('FORBIDDEN', error.message)
    case 'NOT_FOUND':
      return new OperationError('NOT_FOUND', error.message)
    case 'CONFLICT':
    case 'PRECONDITION_FAILED':
      return new OperationError('CONFLICT', error.message)
  }
}

export function createProtocolHostPort(deps: ProtocolHostPortDeps): ProtocolHostPort {
  const handlers = new Map<string, Set<(end: ProtocolRunEnd) => void>>()
  /** The protocol of `owner` named `<plugin>:<key>`, if the owner has one. */
  const findOf = (plugin: string, owner: string, key: string) => {
    const name = hostNameOf(plugin, key)
    return deps.protocols.list(owner).find((p) => p.name === name)
  }
  /** Who may read or change a plugin's protocol through the port: the owner role, or the person it belongs to. */
  const mayTouch = (caller: HostCaller, owner: string): boolean =>
    caller.role === 'owner' || caller.personId === owner

  return {
    async upsertTime(plugin, caller, input): Promise<ProtocolTimeInfo> {
      // `keith` is the self layer's name: no plugin makes a protocol of it (ADR-0020)
      if (input.owner === KEITH_OWNER)
        throw new OperationError('FORBIDDEN', 'a plugin sets protocols for a person, not for keith')
      const name = hostNameOf(plugin, input.key)
      const definition = definitionOf(input)
      const existing = findOf(plugin, input.owner, input.key)
      try {
        const view =
          existing === undefined
            ? deps.service.save(callerOf(caller), { owner: input.owner, name, definition })
            : deps.service.save(callerOf(caller), {
                id: existing.id,
                owner: input.owner,
                name,
                definition,
                expectedVersion: existing.version,
              })
        const nextFireAt =
          input.when.kind === 'once'
            ? input.when.at
            : (nextCronSlot(input.when.expr, deps.now()) ?? null)
        return { key: input.key, protocolId: view.id, nextFireAt }
      } catch (error) {
        throw asOperationError(error)
      }
    },

    async cancel(plugin, caller, key, owner): Promise<boolean> {
      // a person who may not touch it learns nothing: the same answer as a missing protocol
      if (!mayTouch(caller, owner)) return false
      const row = findOf(plugin, owner, key)
      if (row === undefined) return false
      try {
        deps.service.remove(callerOf(caller), row.id)
        return true
      } catch (error) {
        throw asOperationError(error)
      }
    },

    onRunEnd(plugin, handler) {
      const set = handlers.get(plugin) ?? new Set()
      set.add(handler)
      handlers.set(plugin, set)
      return () => void set.delete(handler)
    },

    async runEnded(runId, status) {
      const run = deps.runs.get(runId)
      if (run === undefined) return
      const protocol = deps.protocols.get(run.protocolId)
      if (protocol === undefined) return
      // a plugin's protocol is named `<plugin>:<key>`; any other protocol is nobody's plugin
      const at = protocol.name.indexOf(':')
      if (at < 1) return
      const plugin = protocol.name.slice(0, at)
      const key = protocol.name.slice(at + 1)
      for (const handler of handlers.get(plugin) ?? []) {
        handler({ plugin, key, runId, owner: protocol.owner, status })
      }
    },
  }
}

/** A port that forwards to an implementation bound later (the plugins are wired before the service). */
export function delegatingProtocolsPort(): DelegatingProtocolsPort {
  let impl: ProtocolHostPort | undefined
  const bound = (): ProtocolHostPort => {
    if (impl === undefined) throw new OperationError('CONFLICT', 'protocols are not available yet')
    return impl
  }
  return {
    port: {
      // async: a call before the bind is a refused promise, like every other refusal of the port
      upsertTime: async (plugin, caller, input) => bound().upsertTime(plugin, caller, input),
      cancel: async (plugin, caller, key, owner) => bound().cancel(plugin, caller, key, owner),
      onRunEnd: (plugin, handler) => bound().onRunEnd(plugin, handler),
    },
    bind(next) {
      impl = next
    },
    runEnded: (runId, status) =>
      impl === undefined ? Promise.resolve() : impl.runEnded(runId, status),
  }
}
