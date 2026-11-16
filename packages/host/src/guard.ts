import { AclError, type AclStore, aclActorOf } from '@keith/acl'
import type { Actor } from '@keith/contracts'
import type { AccessPort, AclWriteAudit, OwnerAccessPort, PeoplePort } from './access.ts'
import { buildCtx } from './ctx.ts'
import { GuardError, OperationError } from './errors.ts'
import { createPublisher, type Publisher } from './events.ts'
import type { ProtocolsPort } from './protocols.ts'
import { createRateLimiter } from './rate-limit.ts'
import type { SchedulePort } from './schedule.ts'
import type {
  AuditPort,
  Clock,
  Contribution,
  EventPort,
  KeithPlugin,
  NotifyPort,
  PluginServices,
  PluginStorage,
  ResolvedOperation,
  ReviewPort,
  ReviewTicket,
  SessionFacts,
  Surface,
} from './types.ts'

/** What the people directory says about a person, read now. */
export interface ActorFacts {
  actor: Actor
  status: 'active' | 'suspended'
  /** Role table, grants and plugin role defaults, as capability ids. */
  capabilities: ReadonlySet<string>
}

/** The port to the people directory (core: `createAclActors` plus the capability lookup). */
export interface ActorDirectory {
  /** `undefined` for an unknown person. Must read the stored state on every call; never cache. */
  resolve(principalId: string): Promise<ActorFacts | undefined> | ActorFacts | undefined
}

export interface GuardDeps {
  directory: ActorDirectory
  acl: AclStore
  audit: AuditPort
  clock: Clock
  /** The validated config of a plugin (default: an empty object). */
  config?: (pluginId: string) => Readonly<Record<string, unknown>>
  log?: { warn(message: string): void }
  /** The scoped `db` and `kv` of a plugin (core: `createPluginStorage`). Without it `k.db` and `k.kv` throw. */
  storage?: (pluginId: string) => PluginStorage
  /** The loaded plugin of an id: what `k.call` resolves its target through (a plugin that is not loaded is not callable). */
  plugin?: (pluginId: string) => KeithPlugin | undefined
  /** The services a plugin may read (`requires` only; core: the service registry). */
  services?: (plugin: KeithPlugin) => PluginServices
  /** The live contributions to a point that `pluginId` declares (`k.contributions`). Without it a declared point reads as empty. */
  contributions?: (pluginId: string, point: string) => readonly Contribution[]
  /** Where typed events go (core: the activity feed, one record per recipient). */
  events?: EventPort
  /** Where notices go (core: the same feed, as a `notice` event to the person). */
  notices?: NotifyPort
  /** The owner review queue (core). Without it an operation with a `review` rule is refused, never run unreviewed. */
  reviews?: ReviewPort
  /**
   * Runs a synchronous function as one write transaction over the core database (`k.transaction`; core: one
   * `BEGIN IMMEDIATE` on the handle the ACL and the plugin storage share). Without it `k.transaction` throws.
   */
  transaction?: <T>(fn: () => T) => T
  /** The core's timers for plugins (`k.schedule`). Without it `k.schedule` throws. */
  schedule?: SchedulePort
  /** The core's protocol port (`k.protocols`, docs/specs/plugins/reminders.md). Without it `k.protocols` throws. */
  protocols?: ProtocolsPort
  /** The core's access service (`k.access`). Without it `k.access` throws. */
  access?: AccessPort
  /** Names of people (`k.people`). Without it `k.people` throws. */
  people?: PeoplePort
  /** The ACL audit of the instance owner's root reads (`k.audit.ownerAccess`). Without it the call is a no-op. */
  ownerAccess?: OwnerAccessPort
  /** The audit of the plugins' own resource writes (`k.acl.createResource|removeResource`: `acl.create`, `acl.remove`). Without it those writes are not audited. */
  aclWrites?: AclWriteAudit
}

/** Who asks and how the call arrived. `principal` is the opaque `{ id }` of eharness; nothing else of it is trusted. */
export interface GuardCall {
  principal: { id: string } | undefined
  session: SessionFacts
  signal?: AbortSignal
  /** Set by `k.call` only: how many calls deep this one is (0 for a call from a tool, a route or the core). */
  depth?: number
  /** Set by `k.call` only: `<plugin>.<operation>` of the caller, for the audit row. */
  caller?: string
  /** Set only by the core when it replays an approved review: the review id. The `review` step is skipped; every other check runs. */
  approvedReview?: string
}

export interface Guard {
  /** Typed events and notices with the checks of the host (declared, parsed, capped, rate limited). */
  readonly publisher: Publisher
  run(op: ResolvedOperation, rawInput: unknown, call: GuardCall): Promise<unknown>
  /** Whether an actor sees an operation: actor facts and the static declaration only, never ACL state. */
  visible(op: ResolvedOperation, facts: ActorFacts | undefined, surface: Surface): boolean
  /** The operations of the plugins an actor sees on one surface. */
  catalog(
    plugins: readonly KeithPlugin[],
    facts: ActorFacts | undefined,
    surface: Surface,
  ): ResolvedOperation[]
}

const DENIAL_WINDOW_MS = 10 * 60_000

const holds = (facts: ActorFacts, capability: string): boolean =>
  capability === 'authenticated' || facts.capabilities.has(capability)

/** The static part of "may this actor use this operation", shared by the catalog and `run`. */
function allowed(
  op: ResolvedOperation,
  facts: ActorFacts | undefined,
): 'ok' | 'actor' | 'status' | 'capability' | 'audience' {
  if (facts === undefined || facts.actor.kind === 'system') return 'actor'
  if (facts.status !== 'active') return 'status'
  if (!holds(facts, op.permission.capability)) return 'capability'
  if (facts.actor.kind === 'guest' && op.audience !== 'public') return 'audience'
  return 'ok'
}

/**
 * Whether an actor is offered an operation on a surface: the static facts (`allowed`) and the declaration. On the
 * AI surface a guest is offered only an operation that says `expose.guest`, and a person only one that says
 * `expose.ai` (so a guest-only operation never reaches a person's agent).
 */
function isVisible(
  op: ResolvedOperation,
  facts: ActorFacts | undefined,
  surface: Surface,
): boolean {
  if (allowed(op, facts) !== 'ok') return false
  if (surface === 'ai' && facts?.actor.kind === 'guest') return op.expose.guest
  return op.expose[surface]
}

export function createGuard(deps: GuardDeps): Guard {
  const limiter = createRateLimiter(deps.clock)
  const publisher = createPublisher({
    events: deps.events,
    notices: deps.notices,
    clock: deps.clock,
    log: deps.log,
  })
  const denials = new Map<string, number>()
  const actorKey = (a: Actor): string =>
    a.kind === 'user' && a.personId !== null ? a.personId : `guest:${a.principalId}`

  const audit = (kind: string, actor: Actor | undefined, detail: Record<string, unknown>): void => {
    try {
      deps.audit.record({
        kind,
        actor: actor === undefined ? 'system' : actorKey(actor),
        via: actor?.via ?? 'tcp',
        detail,
      })
    } catch (error) {
      deps.log?.warn(`plugins: audit failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  const requestReview = (
    op: ResolvedOperation,
    payload: unknown,
    actor: Actor,
    reason: string | undefined,
  ): ReviewTicket => {
    if (actor.kind !== 'user' || actor.personId === null || deps.reviews === undefined)
      return deny(op, actor, 'audience')
    const made = deps.reviews.request({
      requester: actor.personId,
      plugin: op.pluginId,
      operation: op.name,
      payload,
      reason,
    })
    if (!made.ok)
      throw new GuardError(
        'RATE_LIMITED',
        'review',
        'too many requests are already waiting for the owner: try again later',
      )
    audit(`plugin.${op.pluginId}.review.requested`, actor, { operation: op.name, review: made.id })
    return {
      review: { id: made.id, status: 'pending', message: 'sent to the owner for review' },
    }
  }
  const deny = (op: ResolvedOperation, actor: Actor | undefined, reason: string): never => {
    if (reason !== 'actor' && actor !== undefined) {
      const key = `${actorKey(actor)}|${op.toolName}|${reason}`
      const now = deps.clock.now()
      const last = denials.get(key)
      if (last === undefined || now - last >= DENIAL_WINDOW_MS) {
        denials.set(key, now)
        audit('plugin.denied', actor, { plugin: op.pluginId, operation: op.name, reason })
      }
    }
    throw new GuardError('NOT_FOUND', reason)
  }

  const guard: Guard = {
    publisher,
    visible: (op, facts, surface) => isVisible(op, facts, surface),
    catalog: (plugins, facts, surface) =>
      plugins.flatMap((p) => p.operations.filter((op) => isVisible(op, facts, surface))),

    async run(op, rawInput, call) {
      // 1 actor: re-read now, never from the stored principal
      const id = call.principal?.id
      const facts =
        typeof id === 'string' && id !== '' ? await deps.directory.resolve(id) : undefined
      // 2-4 status, capability, audience
      const verdict = allowed(op, facts)
      if (verdict !== 'ok' || facts === undefined)
        return deny(op, facts?.actor, verdict === 'ok' ? 'actor' : verdict)
      const actor = facts.actor
      // 5 input
      const parsed = op.input.safeParse(rawInput)
      if (!parsed.success)
        throw new GuardError(
          'INVALID_INPUT',
          'input',
          parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        )
      // 6 acl
      const rule = op.permission.resource
      if (rule?.id !== undefined) {
        const resourceId = (rule.id as (input: unknown) => string | undefined)(parsed.data)
        const acl = aclActorOf(actor)
        if (
          resourceId === undefined ||
          acl === undefined ||
          !deps.acl.check(acl, rule.kind, resourceId, rule.bits).allowed
        )
          return deny(op, actor, 'acl')
      }
      // 7 review: held for the owner (the owner is never held back; a replay of an approved review is not held again)
      if (op.review !== undefined && call.approvedReview === undefined && actor.role !== 'owner') {
        const holds =
          op.review === 'owner' ||
          (op.review.when as (input: unknown, actor: Actor) => boolean)(parsed.data, actor)
        if (holds) return requestReview(op, parsed.data, actor, undefined)
      }
      // 8 rate limit
      if (op.rateLimit !== undefined) {
        const wait = limiter.take(`${actorKey(actor)}|${op.toolName}`, op.rateLimit)
        if (wait !== undefined)
          throw new GuardError('RATE_LIMITED', 'rate', 'too many calls: try again later', wait)
      }
      // 9 run (the context is built here, from this call's actor)
      const k = buildCtx(
        deps,
        op,
        actor,
        facts,
        call,
        publisher,
        guard.run,
        (target, input, reason) => requestReview(target, input, actor, reason),
      )
      const audited = op.risk !== 'read'
      const detailOf = (outcome: 'ok' | 'error'): Record<string, unknown> => ({
        outcome,
        ...(call.caller === undefined ? {} : { from: call.caller }),
        ...(call.approvedReview === undefined ? {} : { review: call.approvedReview }),
      })
      let result: unknown
      try {
        result = await (op.run as (input: unknown, k: unknown) => unknown)(parsed.data, k)
      } catch (error) {
        if (audited) audit(`plugin.${op.pluginId}.${op.name}`, actor, detailOf('error'))
        throw mapError(error, op, deps)
      }
      const out = op.output.safeParse(result)
      if (!out.success) {
        deps.log?.warn(`plugins: ${op.toolName} returned an output that does not match its schema`)
        if (audited) audit(`plugin.${op.pluginId}.${op.name}`, actor, detailOf('error'))
        throw new GuardError('INTERNAL', 'output')
      }
      if (audited) audit(`plugin.${op.pluginId}.${op.name}`, actor, detailOf('ok'))
      return out.data
    },
  }
  return guard
}

function mapError(error: unknown, op: ResolvedOperation, deps: GuardDeps): GuardError {
  if (error instanceof GuardError) return error
  if (error instanceof OperationError) return new GuardError(error.code, 'operation', error.message)
  if (error instanceof AclError) {
    if (error.code === 'NOT_FOUND') return new GuardError('NOT_FOUND', 'acl')
    if (error.code === 'FORBIDDEN') return new GuardError('FORBIDDEN', 'acl', 'not permitted')
    if (error.code === 'CONFLICT') return new GuardError('CONFLICT', 'acl', 'conflict')
    return new GuardError('INVALID_INPUT', 'acl', 'invalid request')
  }
  deps.log?.warn(
    `plugins: ${op.toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  return new GuardError('INTERNAL', 'run')
}
