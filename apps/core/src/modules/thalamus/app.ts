import type { Capability, Health } from '@keith/contracts'
import type { CredentialsRepo, TokensRepo } from '@keith/db'
import { RPCHandler } from '@orpc/server/fetch'
import type { HarnessAgent, SessionLock } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { createHarnessHttp, type HttpDeny } from 'eharness/http'
import { Hono } from 'hono'
import type { RpcContext } from '../../platform/rpc.ts'
import { type FrontGenerationOf, frontSessionId, principalOf } from '../../platform/sessions.ts'
import type { AttentionOptions } from '../amygdala/index.ts'
import { type Audit, auditAnswer, noAudit, readAnswer } from '../audit/index.ts'
import {
  type AuthRoutes,
  type Capabilities,
  createPrincipalResolver,
  type DeviceLogin,
  type LocalAccess,
  type Principal,
  roleCapabilities,
  type Via,
} from '../auth/index.ts'
import { emit } from '../brain-events/index.ts'
import { activityFilter } from './activity-filter.ts'
import type { OpenStreams } from './open-streams.ts'

/** `/plugins/*` (docs/specs/plugins.md): the plugin module answers; thalamus only resolves who asks. */
export interface PluginRoutesPort {
  handle(
    request: Request,
    context: { principal: Principal | undefined; via: Via },
  ): Promise<Response>
}

export interface ThalamusOptions {
  agent: HarnessAgent
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
  /** Legacy `keith_<b64>` tokens. */
  tokens: TokensRepo
  /** Session credentials (`keith_s_…`). */
  credentials: CredentialsRepo
  /** The security log (default: records nothing). */
  audit?: Audit
  /** `POST /auth/device/start` and `/auth/device/poll` (open: the code and poll secret are the credentials). */
  device?: DeviceLogin
  // biome-ignore lint/suspicious/noExplicitAny: the router type is checked where it is built
  router: any
  health: () => Health
  lock?: SessionLock
  /** The activity feed: served at `/activity` and fed with `brain.thalamus.routed`. */
  activity?: { store: ActivityStore; bootId: string; warn?: (message: string) => void }
  /** A message of a person was sent to their front session (`chat.validate`): presence writes its `activity` signal. */
  onRouted?: (personId: string) => void
  /** What waits for the owner: served at `/attention` and `/attention/:id/answer`. */
  attention?: AttentionOptions
  /** `POST /auth/login` (open) and `POST /auth/step-up` (a bearer, resolved by the middleware). */
  auth?: AuthRoutes
  /** The local socket's idle-lock: `423 locked` for every socket request but `/health` and the unlock route. */
  local?: LocalAccess
  /** Role table plus grants (default: the role table only). */
  capabilities?: Capabilities
  /** Clock of the principal resolver (tests: the step-up window). */
  now?: () => number
  /** `POST /plugins/<id>/<op>` and `GET /plugins/openapi.json`, behind the bearer. */
  plugins?: PluginRoutesPort
  /**
   * The registry of long-lived requests: the activity feed, the session streams and `/attention`
   * are tracked in it so a revoked, suspended or changed person's open streams are closed.
   */
  streams?: OpenStreams
  /** `POST /nodes/join` (open: the pairing code is the credential); `clientKey` = caller address. */
  join?: (request: Request, clientKey: string) => Promise<Response>
}

/** What the server hands to `app.fetch` as `env`: the caller's address (rate limit of pairing). */
export interface CoreBindings {
  /** `'local'` for the owner-only Unix socket (owner without a token); absent or `'tcp'` otherwise. */
  via?: Via
  ip?: string
  /** The request carried proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-User-*`). */
  forwarded?: boolean
  /** The request came through Tailscale Funnel (`Tailscale-Funnel-Request`). */
  funnel?: boolean
  /** Lifts the server's idle timeout for this request (long-lived streams, after auth). */
  keepAlive?: () => void
}

/** Paths that need no principal (the join code, device codes and `/health` are their own proof). */
const OPEN_PATHS = new Set([
  '/health',
  '/nodes/join',
  '/nodes/ws',
  '/auth/device/start',
  '/auth/device/poll',
  '/auth/login',
  '/auth/methods',
  '/auth/identify',
  '/auth/local/unlock',
  '/auth/local/session',
  '/auth/local/status',
  '/auth/local/first-owner',
])

/**
 * The capability a non-rpc route needs (docs/specs/permissions.md): chat for the session routes and
 * the activity feed, `approvals.answer` for `/attention`. `/health` needs none.
 */
const ROUTE_CAPABILITY: Record<string, Capability | undefined> = {
  health: undefined,
  'attention.list': 'approvals.answer',
  'attention.answer': 'approvals.answer',
}
const capabilityOfAction = (action: string): Capability | undefined =>
  action in ROUTE_CAPABILITY ? ROUTE_CAPABILITY[action] : 'chat'

/** The first 120 characters of the text of the last user message of a chat request. */
function previewOf(messages: Array<{ role: string; parts?: unknown[] }>): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const text = (last?.parts ?? [])
    .map((p) =>
      (p as { type?: string; text?: string }).type === 'text'
        ? ((p as { text?: string }).text ?? '')
        : '',
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

/**
 * Thalamus: the single entry of every message. `/health` is open; `/sessions/*` (chat,
 * `eharness/http`) and `/rpc/*` (the Keith contract, oRPC) need the owner token.
 */
export function createApp(options: ThalamusOptions): Hono<{
  Bindings: CoreBindings
  Variables: { principal: Principal | undefined }
}> {
  // one resolution per request: the middleware below asks first, the other callers get its answer
  const principals = createPrincipalResolver(options.tokens, options.credentials, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.local === undefined
      ? {}
      : { localImplicit: () => options.local?.implicit() ?? true }),
  })
  const audit = options.audit ?? noAudit
  const capabilities = options.capabilities ?? roleCapabilities
  // a tracked request is a copy with a child signal: it keeps the principal the middleware resolved
  const adopted = new WeakMap<Request, Principal>()
  const http = createHarnessHttp<Principal>(options.agent, {
    authorize: async ({ request, action, sessionId }): Promise<Principal | HttpDeny> => {
      const principal = adopted.get(request) ?? (await principals.resolve(request))
      if (principal === undefined) return { deny: 401 }
      const needed = capabilityOfAction(action)
      if (needed !== undefined && !capabilities.of(principal).has(needed)) {
        return { deny: 403, code: 'FORBIDDEN', message: `you do not have the ${needed} capability` }
      }
      // a person reaches only their own front session
      // only the person's current generation: an older id is answered as a session that does not exist (ADR-0030 §6)
      if (
        sessionId !== undefined &&
        sessionId !==
          frontSessionId(principal.personId, options.generations.current(principal.personId))
      ) {
        return { deny: 404 }
      }
      return principal
    },
    // the signed-in person is the session's principal: every hook of the turn reads it
    session: (id, { principal }) =>
      options.agent.session(id, {
        ...(options.lock === undefined ? {} : { lock: options.lock }),
        principal: principalOf(principal.personId),
      }),
    ...(options.attention === undefined ? {} : { attention: options.attention }),
    ...(options.activity === undefined
      ? {}
      : {
          activity: {
            store: options.activity.store,
            bootId: options.activity.bootId,
            filter: (principal: Principal) => activityFilter(principal),
          },
          chat: {
            // runs after authorize, on the sanitised body: a new owner message reached the core
            validate: ({ body, kind, principal }) => {
              if (kind === 'send' && options.activity !== undefined) {
                const sessionId = frontSessionId(
                  principal.personId,
                  options.generations.current(principal.personId),
                )
                emit(
                  options.activity.store,
                  'brain.thalamus.routed',
                  sessionId,
                  null,
                  { region: 'thalamus', sessionId, preview: previewOf(body.messages) },
                  options.activity.warn,
                )
              }
              if (kind === 'send') options.onRouted?.(principal.personId)
              return undefined
            },
          },
        }),
  })
  const rpc = new RPCHandler<RpcContext>(options.router)

  const app = new Hono<{
    Bindings: CoreBindings
    Variables: { principal: Principal | undefined }
  }>()
  app.get('/health', (c) => c.json(options.health()))
  // pre-auth requests keep the server's short idle timeout; a valid token lifts it so chat,
  // activity and attention streams (and oRPC calls) stay open
  app.use('*', async (c, next) => {
    const path = c.req.path
    const local = options.local
    if (
      local !== undefined &&
      c.env?.via === 'local' &&
      path !== '/auth/local/unlock' &&
      path !== '/auth/local/session'
    ) {
      // a locked socket answers nothing but `/health` (above) and the unlock route
      if (local.mode() === 'locked') {
        return c.json(
          {
            error: 'locked',
            code: 'LOCKED',
            status: 423,
            message:
              'the local socket is locked: unlock it with your PIN (keith, or POST /auth/local/unlock)',
          },
          423,
        )
      }
      local.touch(c.req.method, path)
    }
    if (!OPEN_PATHS.has(path) && !path.startsWith('/auth/flow/')) {
      const principal = await principals.resolve(c.req.raw, c.env?.via, c.env?.ip)
      c.set('principal', principal)
      if (principal !== undefined) c.env?.keepAlive?.()
    }
    await next()
  })
  const streams = options.streams
  /**
   * Hand a request to eharness through the registry: its signal can be aborted when the person's
   * access ends. Only event streams stay registered; any other answer releases the entry at once.
   */
  const tracked = async (raw: Request, principal: Principal | undefined): Promise<Response> => {
    if (streams === undefined || principal === undefined) return http.fetch(raw)
    const grantsKey = [...capabilities.of(principal)].sort().join(',')
    const { request, release } = streams.open(principal, raw, grantsKey)
    adopted.set(request, principal)
    let response: Response
    try {
      response = await http.fetch(request)
    } catch (error) {
      release()
      throw error
    }
    if (response.body === null || !response.headers.get('content-type')?.includes('event-stream')) {
      release()
      return response
    }
    const body = response.body.pipeThrough(new TransformStream({ flush: release }))
    return new Response(body, response)
  }
  app.all('/sessions/*', (c) => tracked(c.req.raw, c.get('principal')))
  if (options.activity !== undefined) {
    app.all('/activity', (c) => tracked(c.req.raw, c.get('principal')))
    app.all('/activity/*', (c) => tracked(c.req.raw, c.get('principal')))
  }
  if (options.attention !== undefined) {
    app.all('/attention', (c) => tracked(c.req.raw, c.get('principal')))
    app.all('/attention/*', async (c) => {
      const request = c.req.raw
      // the approval is read before the answer runs: once it is answered it no longer waits
      const pending = await readAnswer(request.clone() as Request, options.attention)
      const response = await tracked(request, c.get('principal'))
      await auditAnswer(audit, {
        pending,
        response,
        principal: c.get('principal'),
        via: c.env?.via ?? 'tcp',
        forwarded: c.env?.forwarded === true,
        ...(options.attention === undefined ? {} : { trail: options.attention }),
      })
      return response
    })
  }
  const device = options.device
  if (device !== undefined) {
    app.post('/auth/device/start', (c) =>
      device.start(c.req.raw, c.env?.ip ?? 'unknown', c.env?.via === 'local' ? 'local' : 'tcp'),
    )
    app.post('/auth/device/poll', (c) =>
      device.poll(c.req.raw, c.env?.ip ?? 'unknown', c.env?.via === 'local' ? 'local' : 'tcp'),
    )
  }
  const auth = options.auth
  if (auth !== undefined) {
    const peerOf = (c: { env?: CoreBindings }) => ({
      via: c.env?.via === 'local' ? ('local' as const) : ('tcp' as const),
      ip: c.env?.ip ?? 'unknown',
      forwarded: c.env?.forwarded === true,
    })
    app.get('/auth/methods', (c) => auth.methods(c.req.raw, peerOf(c)))
    app.post('/auth/login', (c) => auth.login(c.req.raw, peerOf(c)))
    app.post('/auth/identify', (c) => auth.identify(c.req.raw, peerOf(c)))
    app.post('/auth/flow/:id', (c) => auth.flow(c.req.raw, peerOf(c), c.req.param('id')))
    app.post('/auth/step-up', (c) => auth.stepUp(c.req.raw, peerOf(c), c.get('principal')))
  }
  const local = options.local
  if (local !== undefined) {
    // the socket only: over TCP these routes do not exist
    app.post('/auth/local/unlock', (c) =>
      c.env?.via === 'local' ? local.unlock(c.req.raw) : c.notFound(),
    )
    app.post('/auth/local/session', (c) =>
      c.env?.via === 'local' ? local.session(c.req.raw) : c.notFound(),
    )
    // the first-owner flow: the socket only, and only while the owner has no PIN and no password
    app.get('/auth/local/status', (c) =>
      c.env?.via === 'local' ? c.json(local.status()) : c.notFound(),
    )
    app.post('/auth/local/first-owner', (c) =>
      c.env?.via === 'local' ? local.firstOwner(c.req.raw) : c.notFound(),
    )
    app.post('/auth/local/lock', (c) => {
      if (c.env?.via !== 'local') return c.notFound()
      return c.get('principal') === undefined
        ? c.json({ error: 'unauthorized' }, 401)
        : local.lock()
    })
  }
  const join = options.join
  if (join !== undefined) {
    app.post('/nodes/join', (c) => join(c.req.raw, c.env?.ip ?? 'unknown'))
  }
  const plugins = options.plugins
  if (plugins !== undefined) {
    app.all('/plugins/*', (c) =>
      plugins.handle(c.req.raw, { principal: c.get('principal'), via: c.env?.via ?? 'tcp' }),
    )
  }
  app.all('/rpc/*', async (c) => {
    const principal = c.get('principal')
    if (principal === undefined) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } }, 401)
    }
    const via: Via = c.env?.via ?? 'tcp'
    const forwarded = c.env?.forwarded === true
    const funnel = c.env?.funnel === true
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/rpc',
      context: {
        principal,
        capabilities: capabilities.of(principal),
        via,
        ip: c.env?.ip,
        forwarded,
        funnel,
        record: (kind, detail) =>
          audit.record({
            kind,
            actor: principal.personId,
            via,
            detail: { ...detail, ...(forwarded ? { forwarded: true } : {}) },
          }),
      },
    })
    return matched ? response : c.notFound()
  })
  return app
}
