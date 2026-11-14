import {
  type AuthZone,
  GUEST_BANNER,
  GUEST_BASE_PATH,
  GUEST_LIMITS,
  GUEST_NOTICE_HEADER,
  GUEST_TURNS_LEFT_HEADER,
  GUEST_WATCHED_HEADER,
  type GuestBlock,
  type GuestEndReason,
  type GuestHttpErrorCode,
  type GuestLimitsView,
  type GuestPublicStatus,
  type GuestSettings,
  GuestStartInputSchema,
  type GuestStartResponse,
} from '@keith/contracts'
import { createHarnessHttp } from 'eharness/http'
import { Hono } from 'hono'
import { type LanNets, zoneOf } from '../auth/index.ts'
import type { EntryGate, GuestRegistry, GuestSession } from '../guests/index.ts'
import { clientAddress } from './guest-address.ts'
import { type BearerStore, guestTokenOf, type IpHasher, newGuestToken } from './guest-bearer.ts'
import type { StartLimiter } from './guest-limiter.ts'
import { type GuestLine, scrubResponse } from './guest-scrub.ts'

/** What the guest app reads of the owner's guest settings, per request. */
export interface GuestSettingsView {
  get(): GuestSettings
  killed(): boolean
}

export interface GuestAppOptions {
  registry: GuestRegistry
  settings: GuestSettingsView
  /** The owner-side entry gate: `status` asks it whether a session could start now. */
  gate: EntryGate
  lan: () => LanNets
  hasher: IpHasher
  limiter: StartLimiter
  /** The per-IP window of `GET /guest/status` (its own bucket: a poll never uses up the starts). */
  statusLimiter: StartLimiter
  bearers: BearerStore
  /** Aggregates refusals per address hash (audit, step 7). `reason` is a short label, never a text. */
  onDenied?: (denied: { ipHash: string; reason: string }) => void
  /** The text of the banner (default `GUEST_BANNER`). */
  banner?: string
  /** The visitor's text for a failed turn, read at the error (the persona's line; default the professional line). */
  guestLine?: GuestLine
}

/** What the server hands to `app.fetch` as `env`: the peer address, whether proxy headers came, the idle-timeout lift. */
export interface GuestBindings {
  ip?: string
  forwarded?: boolean
  keepAlive?: () => void
}

/**
 * Session routes a visitor may use: the chat, resuming its stream and interrupt. Reading the stored session is not
 * offered: its snapshot and messages carry the model id, token counts and cost, and the client keeps its own transcript.
 */
const ALLOWED_ACTIONS = new Set(['chat', 'chat.resume', 'chat.interrupt'])

/** Largest request body of a guest route (a message is 2 KiB; JSON and parts need some room). */
const MAX_BODY_BYTES = 16 * 1024

const NOTICE_SHORT =
  'anonymous; not stored by keith; the owner can watch a live session; the model provider receives your messages'

const BLOCK_STATUS: Record<GuestBlock, { status: 403 | 429 | 503; code: GuestHttpErrorCode }> = {
  killed: { status: 403, code: 'GUEST_DISABLED' },
  disabled: { status: 403, code: 'GUEST_DISABLED' },
  full: { status: 429, code: 'GUEST_BUSY' },
  'daily-cap': { status: 429, code: 'GUEST_CAP' },
  'monthly-cap': { status: 429, code: 'GUEST_CAP' },
  'no-model': { status: 503, code: 'GUEST_UNAVAILABLE' },
  'unpriced-model': { status: 503, code: 'GUEST_UNAVAILABLE' },
  'no-limit': { status: 503, code: 'GUEST_UNAVAILABLE' },
  'owner-floor': { status: 503, code: 'GUEST_UNAVAILABLE' },
}
/** The same message for every refusal of one code: a visitor learns nothing about the owner's setup. */
const MESSAGES: Record<GuestHttpErrorCode, string> = {
  GUEST_UNAUTHORIZED: 'missing or invalid guest token',
  GUEST_DISABLED: 'guest chat is not available',
  GUEST_ZONE: 'guest chat is not available from your network',
  GUEST_RATE_LIMITED: 'too many chats started from your address: try again later',
  GUEST_BUSY: 'guest chat is busy: try again in a little while',
  GUEST_CAP: 'guest chat has reached its limit for now: try again later',
  GUEST_UNAVAILABLE: 'guest chat is not available right now',
  GUEST_SESSION_ENDED: 'this chat has ended',
  GUEST_NOT_FOUND: 'not found',
  GUEST_BAD_REQUEST: 'bad request',
}

const baseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  [GUEST_NOTICE_HEADER]: NOTICE_SHORT,
}

function failure(
  code: GuestHttpErrorCode,
  status: number,
  details?: Record<string, unknown>,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message: MESSAGES[code], ...(details === undefined ? {} : { details }) } },
    { status, headers: { ...baseHeaders, ...extra } },
  )
}
const ok = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: baseHeaders })

/** What the visitor may see of the limits of a session (the money caps and models stay private). */
export const limitsViewOf = (limits: GuestSession['limits']): GuestLimitsView => ({
  maxTurns: limits.maxTurns,
  maxInputChars: GUEST_LIMITS.maxInputChars,
  idleMs: limits.idleMs,
  absoluteMs: limits.absoluteMs,
})

/**
 * The guest listener's app (docs/specs/guests.md, "Guest HTTP"): `/health` and `/guest/*` only, nothing of the owner
 * API. Entry order of `POST /guest/session`: kill switch, enabled, zone (from the TCP peer), per-IP window, the
 * owner-side gate and concurrency (`registry.open`). The Host check runs before this app (`createRequestGuard`).
 * Later traffic carries the bearer of the session, bound to the address that started it.
 */
export function createGuestApp(options: GuestAppOptions): Hono<{ Bindings: GuestBindings }> {
  const { registry, settings, gate, hasher, bearers, limiter, statusLimiter } = options
  const banner = options.banner ?? GUEST_BANNER
  const denied = (ip: string, reason: string): void => {
    try {
      options.onDenied?.({ ipHash: hasher.daily(ip), reason })
    } catch {
      // counting a refusal never breaks the answer
    }
  }
  // the bearer store learns why a session ended, to answer 410; the app lives as long as the registry
  registry.onEnded((id, reason) => bearers.end(id, reason))
  const zoneOfRequest = (request: Request, env: GuestBindings | undefined): AuthZone =>
    zoneOf({
      ip: env?.ip,
      forwarded: env?.forwarded === true,
      headers: request.headers,
      // a proxy header is never trusted here: a loopback peer behind one is `public`
      proxy: 'none',
      lan: options.lan(),
    }).zone
  const zoneAllowed = (zone: AuthZone): boolean => settings.get().zones.includes(zone)
  /** The visitor's address for the windows and the bearer bind: behind a trusted proxy, the proxy's header (ADR-0027 §21). */
  const addressOf = (request: Request, env: GuestBindings | undefined): string | undefined =>
    clientAddress(env?.ip, request.headers, settings.get())
  const authed = new WeakMap<Request, GuestSession>()

  const http = createHarnessHttp<{ guest: GuestSession }>(undefined, {
    basePath: GUEST_BASE_PATH,
    maxBodyBytes: MAX_BODY_BYTES,
    headers: { 'x-content-type-options': 'nosniff', [GUEST_NOTICE_HEADER]: NOTICE_SHORT },
    authorize: ({ request, action, sessionId }) => {
      const guest = authed.get(request)
      if (guest === undefined) return { deny: 401 }
      if (!ALLOWED_ACTIONS.has(action)) return { deny: 404 }
      if (sessionId !== undefined && sessionId !== guest.sessionId) return { deny: 404 }
      return { guest }
    },
    session: (_id, { principal }) => principal.guest.session(),
    peek: (_id, { principal }) => principal.guest.agent.peek(principal.guest.sessionId),
    chat: {
      // one text part per message; the turn counter, the size and the no-files rule are the guest agent's own
      maxParts: 1,
      maxTextBytes: GUEST_LIMITS.maxInputChars * 4,
      authorizeKind: ({ kind }) => (kind === 'send' ? undefined : { deny: 404 }),
      validate: ({ body, kind }) => {
        if (kind !== 'send') return undefined
        const last = body.messages[body.messages.length - 1]
        const parts = (last?.parts ?? []) as Array<{ type: string; text?: string }>
        if (parts.some((p) => p.type !== 'text'))
          return failure('GUEST_BAD_REQUEST', 400, { reason: 'text-only' })
        const chars = parts.reduce((n, p) => n + (p.text?.length ?? 0), 0)
        if (chars > GUEST_LIMITS.maxInputChars)
          return failure('GUEST_BAD_REQUEST', 413, {
            reason: 'input-too-long',
            maxInputChars: GUEST_LIMITS.maxInputChars,
          })
        return undefined
      },
    },
  })

  const app = new Hono<{ Bindings: GuestBindings }>()

  app.get('/health', () => ok({ status: 'ok' }))

  app.get(`${GUEST_BASE_PATH}/status`, async (c) => {
    const taken = statusLimiter.take(hasher.bind(addressOf(c.req.raw, c.env) ?? 'unknown'))
    if (!taken.allowed) {
      return failure('GUEST_RATE_LIMITED', 429, undefined, {
        'retry-after': String(Math.ceil(taken.retryAfterMs / 1000)),
      })
    }
    const config = settings.get()
    const zone = zoneOfRequest(c.req.raw, c.env)
    const enabled = config.enabled && !settings.killed() && config.zones.includes(zone)
    const available = enabled && (await gate.peek(registry.size)) === null
    const body: GuestPublicStatus = {
      enabled,
      available,
      banner,
      limits: enabled
        ? limitsViewOf({
            maxTurns: config.maxTurns,
            idleMs: config.idleMs,
            absoluteMs: config.absoluteMs,
          })
        : null,
    }
    return ok(body)
  })

  app.post(`${GUEST_BASE_PATH}/session`, async (c) => {
    const ip = addressOf(c.req.raw, c.env) ?? 'unknown'
    const config = settings.get()
    if (settings.killed() || !config.enabled) {
      denied(ip, 'disabled')
      return failure('GUEST_DISABLED', 403)
    }
    if (!zoneAllowed(zoneOfRequest(c.req.raw, c.env))) {
      denied(ip, 'zone')
      return failure('GUEST_ZONE', 403)
    }
    const bind = hasher.bind(ip)
    const taken = limiter.take(bind)
    if (!taken.allowed) {
      denied(ip, 'rate')
      return failure('GUEST_RATE_LIMITED', 429, undefined, {
        'retry-after': String(Math.ceil(taken.retryAfterMs / 1000)),
      })
    }
    const text = await c.req.text()
    let input: ReturnType<typeof GuestStartInputSchema.safeParse>
    try {
      input = GuestStartInputSchema.safeParse(text === '' ? {} : JSON.parse(text))
    } catch {
      input = GuestStartInputSchema.safeParse(undefined)
    }
    if (!input.success || text.length > 1024) return failure('GUEST_BAD_REQUEST', 400)
    const opened = await registry.open({
      zone: zoneOfRequest(c.req.raw, c.env),
      ipHash: hasher.daily(ip),
      ...(input.data.clientKind === undefined ? {} : { clientKind: input.data.clientKind }),
    })
    if (!opened.ok) {
      denied(ip, opened.block)
      const { status, code } = BLOCK_STATUS[opened.block]
      return failure(code, status, undefined, status === 429 ? { 'retry-after': '60' } : {})
    }
    const { session } = opened
    const token = newGuestToken()
    bearers.add(session.id, token, bind)
    c.env?.keepAlive?.()
    const body: GuestStartResponse = {
      sessionId: session.sessionId,
      token,
      expiresAt: opened.expiresAt,
      limits: limitsViewOf(session.limits),
      notice: banner,
    }
    return ok(body, 201)
  })

  /** The bearer of `/guest/sessions/:id/*`: the right token, from the address that started it, for a live session. */
  const authenticate = (
    request: Request,
    env: GuestBindings | undefined,
    pathId: string,
  ): { guest: GuestSession } | { response: Response } => {
    const unauthorized = { response: failure('GUEST_UNAUTHORIZED', 401) }
    const token = guestTokenOf(request)
    if (token === undefined) return unauthorized
    const key = pathId.startsWith('guest:') ? pathId.slice('guest:'.length) : pathId
    const ip = addressOf(request, env)
    if (ip === undefined) return unauthorized
    const checked = bearers.check(key, token, hasher.bind(ip))
    if (!checked.ok) {
      if (checked.why !== 'ended') return unauthorized
      return {
        response: failure('GUEST_SESSION_ENDED', 410, { reason: checked.reason as GuestEndReason }),
      }
    }
    const guest = registry.get(key)
    if (guest === undefined) return unauthorized
    if (!zoneAllowed(zoneOfRequest(request, env))) return { response: failure('GUEST_ZONE', 403) }
    registry.touch(key)
    env?.keepAlive?.()
    return { guest }
  }

  app.delete(`${GUEST_BASE_PATH}/sessions/:id`, async (c) => {
    const auth = authenticate(c.req.raw, c.env, c.req.param('id'))
    if ('response' in auth) return auth.response
    await registry.end(auth.guest.id, 'closed')
    return ok({ ended: true })
  })

  app.all(`${GUEST_BASE_PATH}/sessions/:id/*`, async (c) => {
    const auth = authenticate(c.req.raw, c.env, c.req.param('id'))
    if ('response' in auth) return auth.response
    authed.set(c.req.raw, auth.guest)
    // the answer stream is scrubbed: no model id, usage, cost, context or provider error text reaches a visitor
    const response = scrubResponse(await http.fetch(c.req.raw), options.guestLine)
    try {
      const { turns } = auth.guest.info()
      response.headers.set(
        GUEST_TURNS_LEFT_HEADER,
        String(Math.max(0, auth.guest.limits.maxTurns - turns)),
      )
      // once an owner has opened this session with `admin.guests.peek`, the visitor is told in every answer
      if (auth.guest.watched) response.headers.set(GUEST_WATCHED_HEADER, '1')
    } catch {
      // an immutable response (never from eharness) just goes out without the extra headers
    }
    return response
  })

  app.notFound(() => failure('GUEST_NOT_FOUND', 404))
  app.onError(() => failure('GUEST_UNAVAILABLE', 500))
  return app
}
