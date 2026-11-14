/**
 * The guest client (docs/specs/client.md, "Guest client"; docs/specs/guests.md, "Guest HTTP"): what an anonymous
 * visitor's UI uses to talk to the guest listener. It needs no login and no config file, stores nothing on disk and
 * keeps the bearer in memory only: when the object is gone the session can no longer be reached.
 */
import {
  GUEST_BASE_PATH,
  GUEST_HTTP_ERROR_CODES,
  GUEST_TURNS_LEFT_HEADER,
  GUEST_WATCHED_HEADER,
  type GuestEndReason,
  GuestEndReasonSchema,
  type GuestHttpErrorCode,
  type GuestLimitsView,
  type GuestPublicStatus,
  GuestPublicStatusSchema,
  GuestStartResponseSchema,
} from '@keith/contracts'

/** The state a failed guest call lands in; a UI shows one clear line for each (`guestFailureText`). */
export type GuestFailureKind =
  | 'unauthorized'
  | 'disabled'
  | 'zone'
  | 'rate-limited'
  | 'busy'
  | 'cap'
  | 'unavailable'
  | 'ended'
  | 'not-found'
  | 'turn-running'
  | 'bad-request'
  | 'unreachable'
  | 'protocol'

/** Every error code of the guest listener maps to one state (a type error when a code is added and not mapped). */
export const GUEST_FAILURE_OF_CODE: Record<GuestHttpErrorCode, GuestFailureKind> = {
  GUEST_UNAUTHORIZED: 'unauthorized',
  GUEST_DISABLED: 'disabled',
  GUEST_ZONE: 'zone',
  GUEST_RATE_LIMITED: 'rate-limited',
  GUEST_BUSY: 'busy',
  GUEST_CAP: 'cap',
  GUEST_UNAVAILABLE: 'unavailable',
  GUEST_SESSION_ENDED: 'ended',
  GUEST_NOT_FOUND: 'not-found',
  GUEST_BAD_REQUEST: 'bad-request',
}

/** The words of the end reasons, as a visitor reads them. */
export const GUEST_END_TEXT: Record<GuestEndReason, string> = {
  closed: 'This chat was closed.',
  idle: 'This chat ended because nothing was sent for a while.',
  absolute: 'This chat reached its time limit.',
  'turn-cap': 'This chat reached its message limit.',
  'cost-cap': 'This chat stopped: guest chat has reached its limit for now.',
  killed: 'The owner turned guest chat off.',
  restart: 'This chat ended because Keith restarted.',
}

const FAILURE_TEXT: Record<Exclude<GuestFailureKind, 'ended'>, string> = {
  unauthorized: 'This chat is no longer valid. Start a new one.',
  disabled: 'Guest chat is not available.',
  zone: 'Guest chat is not available from your network.',
  'rate-limited': 'Too many chats were started from your address. Try again later.',
  busy: 'Guest chat is busy right now. Try again in a little while.',
  cap: 'Guest chat has reached its limit for now. Try again later.',
  unavailable: 'Guest chat is not available right now.',
  'not-found': 'There is no guest chat at this address.',
  'turn-running': 'Keith is still answering the last message.',
  'bad-request': 'That message cannot be sent.',
  unreachable: 'Cannot reach the core.',
  protocol: 'The core answered something this client does not understand.',
}

/** A failed guest call: the state it lands in, and what the core said when it said something. */
export class GuestError extends Error {
  constructor(
    readonly kind: GuestFailureKind,
    readonly status: number,
    message: string,
    readonly details: {
      code?: GuestHttpErrorCode
      /** `410`: why the session ended. */
      reason?: GuestEndReason
      /** `429`: seconds until a retry makes sense (the `Retry-After` header). */
      retryAfter?: number
    } = {},
  ) {
    super(message)
    this.name = 'GuestError'
  }
  get reason(): GuestEndReason | undefined {
    return this.details.reason
  }
  get retryAfter(): number | undefined {
    return this.details.retryAfter
  }
}

/** One clear sentence for a failure (a `410` names its reason). */
export function guestFailureText(error: GuestError): string {
  if (error.kind === 'ended')
    return error.reason === undefined ? 'This chat has ended.' : GUEST_END_TEXT[error.reason]
  return FAILURE_TEXT[error.kind]
}

const isCode = (value: unknown): value is GuestHttpErrorCode =>
  typeof value === 'string' && (GUEST_HTTP_ERROR_CODES as readonly string[]).includes(value)

/** Turn a non-2xx answer into a `GuestError` (by the error code, else by the status). */
async function failureOf(response: Response): Promise<GuestError> {
  let body: { error?: { code?: unknown; details?: { reason?: unknown } } } = {}
  try {
    body = (await response.json()) as typeof body
  } catch {
    // not JSON: the status alone decides
  }
  const code = isCode(body.error?.code) ? body.error.code : undefined
  const reason = GuestEndReasonSchema.safeParse(body.error?.details?.reason)
  const retry = Number(response.headers.get('retry-after'))
  const details = {
    ...(code === undefined ? {} : { code }),
    ...(reason.success ? { reason: reason.data } : {}),
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
  }
  const kind: GuestFailureKind =
    code !== undefined
      ? GUEST_FAILURE_OF_CODE[code]
      : response.status === 409
        ? 'turn-running'
        : response.status === 401
          ? 'unauthorized'
          : response.status === 410
            ? 'ended'
            : response.status === 404
              ? 'not-found'
              : response.status === 429
                ? 'busy'
                : response.status === 400 || response.status === 413
                  ? 'bad-request'
                  : response.status === 403
                    ? 'disabled'
                    : 'unavailable'
  const error = new GuestError(kind, response.status, '', details)
  error.message = guestFailureText(error)
  return error
}

/** The session a successful `open()` returns: no token (it never leaves the client object). */
export interface GuestSessionView {
  sessionId: string
  expiresAt: number
  limits: GuestLimitsView
  /** The banner the core wants shown (`GUEST_BANNER`). */
  notice: string
}

/** What `chat()` yields while a turn streams. */
export type GuestChatEvent =
  /** First event: the headers of the answer. `turnsLeft` 0 means this is the last message of the chat. */
  | { type: 'meta'; turnsLeft: number | undefined; watched: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error' }
  | { type: 'error'; text: string }
  | { type: 'finish'; stop: string | undefined }

export interface GuestClientOptions {
  /** The guest listener, e.g. `http://192.168.1.20:7421` (not the owner's port). */
  baseUrl: string
  fetch?: typeof fetch
  /** What this client says it is (`tui` by default); a hint the audit row records, never trusted. */
  clientKind?: 'tui' | 'web' | 'other'
}

export interface GuestClient {
  /** `GET /guest/status`: whether this caller could start a chat now. Rejects with `unreachable` or `not-found`. */
  status(): Promise<GuestPublicStatus>
  /** `POST /guest/session`: start a chat. The bearer stays inside this object. Rejects with a `GuestError`. */
  open(): Promise<GuestSessionView>
  /** The open session, or `undefined` before `open()` and after `end()` or an ended-state answer. */
  readonly session: GuestSessionView | undefined
  /** `POST .../chat`: send one text message and stream the answer. Rejects (at the first `next()`) with a `GuestError`. */
  chat(text: string, options?: { signal?: AbortSignal }): AsyncGenerator<GuestChatEvent>
  /** `POST .../interrupt`: stop the running turn. Never rejects (a gone session is already stopped). */
  interrupt(): Promise<void>
  /** `DELETE`: end the chat and forget the bearer. Never rejects. */
  end(): Promise<void>
}

const trimUrl = (url: string): string => url.replace(/\/+$/, '')

/** Events of one SSE block (the `data:` lines between blank lines), as parsed JSON; `[DONE]` is dropped. */
function chunkOf(block: string): Record<string, unknown> | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (data === '' || data === '[DONE]') return undefined
  try {
    const parsed = JSON.parse(data) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The event a UI message stream chunk means to a visitor, or `undefined` for the ones it ignores. */
export function eventOf(chunk: Record<string, unknown>): GuestChatEvent | undefined {
  const id = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
  switch (chunk.type) {
    case 'text-delta':
      return typeof chunk.delta === 'string' ? { type: 'text', delta: chunk.delta } : undefined
    case 'tool-input-available':
      return {
        type: 'tool',
        id,
        name: typeof chunk.toolName === 'string' ? chunk.toolName : 'tool',
        state: 'running',
      }
    case 'tool-output-available':
      return { type: 'tool', id, name: '', state: 'done' }
    case 'tool-input-error':
    case 'tool-output-error':
    case 'tool-output-denied':
      return { type: 'tool', id, name: '', state: 'error' }
    case 'error':
      return {
        type: 'error',
        text: typeof chunk.errorText === 'string' ? chunk.errorText : 'The assistant failed.',
      }
    case 'finish': {
      const stop = (chunk.messageMetadata as { eharness?: { stop?: unknown } } | undefined)
        ?.eharness?.stop
      return { type: 'finish', stop: typeof stop === 'string' ? stop : undefined }
    }
    default:
      return undefined
  }
}

/** The typed client of the guest listener (no login, no disk, the bearer in memory only). */
export function createGuestClient(options: GuestClientOptions): GuestClient {
  const base = trimUrl(options.baseUrl)
  const doFetch = options.fetch ?? fetch
  let session: GuestSessionView | undefined
  let token: string | undefined

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await doFetch(`${base}${GUEST_BASE_PATH}${path}`, init)
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new GuestError('unreachable', 0, FAILURE_TEXT.unreachable)
    }
  }
  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  })
  const pathOf = (suffix = ''): string =>
    `/sessions/${encodeURIComponent(session?.sessionId ?? '')}${suffix}`
  const forget = (): void => {
    session = undefined
    token = undefined
  }

  return {
    get session() {
      return session
    },
    async status() {
      const res = await send('/status')
      if (!res.ok) throw await failureOf(res)
      const parsed = GuestPublicStatusSchema.safeParse(await res.json().catch(() => undefined))
      if (!parsed.success) throw new GuestError('protocol', res.status, FAILURE_TEXT.protocol)
      return parsed.data
    },
    async open() {
      const res = await send('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientKind: options.clientKind ?? 'tui' }),
      })
      if (!res.ok) throw await failureOf(res)
      const parsed = GuestStartResponseSchema.safeParse(await res.json().catch(() => undefined))
      if (!parsed.success) throw new GuestError('protocol', res.status, FAILURE_TEXT.protocol)
      token = parsed.data.token
      session = {
        sessionId: parsed.data.sessionId,
        expiresAt: parsed.data.expiresAt,
        limits: parsed.data.limits,
        notice: parsed.data.notice,
      }
      return session
    },
    async *chat(text, { signal } = {}) {
      if (session === undefined || token === undefined)
        throw new GuestError('unauthorized', 401, FAILURE_TEXT.unauthorized)
      const res = await send(
        pathOf('/chat'),
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: session.sessionId,
            trigger: 'submit-message',
            messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
          }),
          ...(signal === undefined ? {} : { signal }),
        }),
      )
      if (!res.ok) {
        const error = await failureOf(res)
        // the core says this chat is over (or the bearer is not accepted any more): drop it
        if (error.kind === 'ended' || error.kind === 'unauthorized') forget()
        throw error
      }
      const left = Number(res.headers.get(GUEST_TURNS_LEFT_HEADER))
      yield {
        type: 'meta',
        turnsLeft:
          res.headers.has(GUEST_TURNS_LEFT_HEADER) && Number.isFinite(left) ? left : undefined,
        watched: res.headers.get(GUEST_WATCHED_HEADER) === '1',
      }
      if (res.body === null) return
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(bytes, { stream: true })
          let at = buffer.indexOf('\n\n')
          while (at >= 0) {
            const chunk = chunkOf(buffer.slice(0, at))
            buffer = buffer.slice(at + 2)
            const event = chunk === undefined ? undefined : eventOf(chunk)
            if (event !== undefined) yield event
            at = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return
        throw new GuestError('unreachable', 0, FAILURE_TEXT.unreachable)
      }
      const rest = buffer.trim() === '' ? undefined : chunkOf(buffer)
      const event = rest === undefined ? undefined : eventOf(rest)
      if (event !== undefined) yield event
    },
    async interrupt() {
      if (session === undefined) return
      try {
        await send(pathOf('/interrupt'), authed({ method: 'POST' }))
      } catch {
        // the turn is stopped or the core is gone: either way nothing to stop
      }
    },
    async end() {
      if (session === undefined) return
      try {
        await send(pathOf(), authed({ method: 'DELETE' }))
      } catch {
        // the core is gone: the session ends there by itself
      } finally {
        forget()
      }
    },
  }
}
