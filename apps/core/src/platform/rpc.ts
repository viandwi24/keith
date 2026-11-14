import { keithContract, type ProcedureMeta } from '@keith/contracts'
import { implement, ORPCError } from '@orpc/server'
import { isHarnessError } from 'eharness'
import type { RecordAudit } from '../modules/audit/index.ts'
import { type Principal, stepUpDenial, type Via } from '../modules/auth/index.ts'

/** Context of every oRPC call: the authenticated principal (thalamus refuses anonymous calls). */
export interface RpcContext {
  principal: Principal
  /** What the principal may do: the role table plus their grants (docs/specs/permissions.md). */
  capabilities: ReadonlySet<string>
  /** The listener the call came in on. */
  via: Via
  /** Peer address of a TCP call (never read from a forwarding header). */
  ip?: string | undefined
  /** The request carried proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-*`): its peer is the proxy, not the client. */
  forwarded?: boolean
  /** The request came through Tailscale Funnel: its client is `public` (docs/specs/client.md). */
  funnel?: boolean
  /** `record(kind, detail)` already bound to this principal and listener. */
  record: RecordAudit
}

/** What to audit after a successful call: settings and nodes (docs/specs/auth.md). Never secrets. */
const AUDITED: Record<
  string,
  (
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => [string, Record<string, unknown>]
> = {
  // `providers.put` is not here: the router knows whether the connection existed (add or key)
  'providers.test': (i, o) => ['settings.provider.test', { connection: i.id, ok: o.ok === true }],
  'providers.remove': (i) => ['settings.provider.remove', { connection: i.id }],
  'models.roles.set': (i) => ['settings.model.set', { role: i.role, ref: i.ref }],
  'models.price.set': (i) => [
    'settings.model.price',
    { ref: i.ref, inputPerMTokUsd: i.inputPerMTokUsd, outputPerMTokUsd: i.outputPerMTokUsd },
  ],
  'models.price.clear': (i) => [
    'settings.model.price',
    { ref: i.ref, inputPerMTokUsd: null, outputPerMTokUsd: null },
  ],
  'budget.set': (i) => ['settings.budget.set', { limitUsd: i.limitUsd ?? null }],
  // the person id (the output), not the typed name
  'budget.setPersonCap': (i, o) => [
    'settings.budget.cap',
    { person: o.personId ?? null, usd: i.usd ?? null },
  ],
  'admin.access.set': (i, o) => [
    'settings.access.set',
    {
      mode: o.mode,
      host: o.host,
      publicUrl: o.publicUrl,
      proxy: o.proxy,
      requested: Object.keys(i),
    },
  ],
  // the owner's raw read of a person's presence: the person it is about (docs/specs/parietal.md)
  'admin.presence.read': (_i, o) => [
    'presence.read',
    { subject: (o.presence as { personId?: unknown } | undefined)?.personId ?? null },
  ],
  // the owner's test notice: the recipient, the run and the outcome; never the text (docs/specs/delivery.md, "Audit")
  'admin.notice.send': (_i, o) => {
    const outcome = (o.outcome ?? {}) as { status?: unknown; route?: unknown; reason?: unknown }
    return [
      'delivery.test_notice',
      {
        to: o.to ?? null,
        id: o.id ?? null,
        status: outcome.status ?? null,
        route: outcome.route ?? null,
        reason: outcome.reason ?? null,
      },
    ]
  },
  'nodes.pair': () => ['node.pair_code', {}],
  'nodes.revoke': (i) => ['node.revoked', { node: i.id }],
}

/**
 * The capability gate (docs/specs/permissions.md): the procedure's metadata names the capability
 * the principal needs, and `stepUp` marks a call a remote principal may only make shortly after
 * confirming with a PIN or password. A procedure without metadata is refused (fail closed; a test
 * also fails the build).
 */
export function authorize(
  meta: Partial<ProcedureMeta> | undefined,
  context: Pick<RpcContext, 'principal' | 'via' | 'capabilities'>,
): void {
  const needed = meta?.capability
  if (needed === undefined)
    throw new ORPCError('FORBIDDEN', { message: 'this call declares no capability' })
  if (needed !== 'authenticated' && !context.capabilities.has(needed))
    throw new ORPCError('FORBIDDEN', { message: `you do not have the ${needed} capability` })
  const denied = meta?.stepUp === true ? stepUpDenial(context.principal, context.via) : undefined
  if (denied !== undefined)
    throw new ORPCError(denied.code, { status: 403, message: denied.message })
}

/** The implementer of the Keith contract; modules build their procedures from it. */
export const rpc = implement(keithContract)
  .$context<RpcContext>()
  .use(async ({ context, path, procedure, next }, input) => {
    authorize(procedure['~orpc'].meta as Partial<ProcedureMeta> | undefined, context)
    const result = await next()
    const spec = AUDITED[path.join('.')]
    if (spec !== undefined) {
      const [kind, detail] = spec(
        (input ?? {}) as Record<string, unknown>,
        ((result as { output?: unknown }).output ?? {}) as Record<string, unknown>,
      )
      context.record(kind, detail)
    }
    return result
  })

/**
 * Map an expected eharness error to a 400 the client can show; everything else is a 500 whose
 * message never leaves the server.
 */
export function rpcError(error: unknown): never {
  if (isHarnessError(error) && error.code === 'EH_CONFIG_INVALID') {
    throw new ORPCError('BAD_REQUEST', { message: error.message })
  }
  throw error
}
