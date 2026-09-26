import {
  HttpErrorBody,
  type LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  type MessageId,
  MessagesResponse,
  type PersonDto,
  type ThreadDto,
  type ThreadId,
  ThreadsResponse,
} from '@keith/protocol'
import { ClientError } from './errors.ts'

/**
 * The core's HTTP API (`/v1/…`, docs/contracts/protocol.md#http-endpoints) over the standard
 * `fetch`. Every response is validated with the `@keith/protocol` schemas. Errors are `ClientError`s.
 */

/** Any schema with zod's `safeParse` shape. The client has no zod dependency of its own. */
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } }

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type HttpOptions = {
  signal?: AbortSignal | undefined
  /** Defaults to the global `fetch`. */
  fetch?: Fetch | undefined
}

/** Normalizes a core address: must be http(s), no trailing slash. */
export function normalizeBaseUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new ClientError('INVALID_URL', `invalid url '${url}'`, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ClientError('INVALID_URL', `url must be http or https, got '${url}'`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

/** The WebSocket URL for a base HTTP URL and a token: `ws://host/v1/ws?token=…`. */
export function wsUrl(baseUrl: string, token: string): string {
  const url = new URL(`${baseUrl}/v1/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

/** `POST /v1/auth/login`. A refusal is `LOGIN_FAILED` with a message fit for a login screen. */
export async function login(
  baseUrl: string,
  body: LoginRequest,
  opts: HttpOptions = {},
): Promise<LoginResponse> {
  const res = await send(baseUrl, '/v1/auth/login', opts, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await readJson(res)
  if (!res.ok) {
    const parsed = HttpErrorBody.safeParse(json)
    if (parsed.success && parsed.data.error.code === 'UNAUTHORIZED') {
      throw new ClientError('LOGIN_FAILED', 'wrong username or password')
    }
    const detail = parsed.success ? parsed.data.error.message : `HTTP ${res.status}`
    throw new ClientError('LOGIN_FAILED', `login failed: ${detail}`)
  }
  return parseBody(LoginResponse, json, 'login')
}

/** `POST /v1/auth/logout`: deletes the token on the core. */
export async function logout(baseUrl: string, token: string, opts: HttpOptions = {}): Promise<void> {
  await getJson(baseUrl, '/v1/auth/logout', token, LogoutResponse, opts, 'POST')
}

/** `GET /v1/me`: the signed-in person. `UNAUTHORIZED` when the token is no longer valid. */
export async function getMe(baseUrl: string, token: string, opts: HttpOptions = {}): Promise<PersonDto> {
  return (await getJson(baseUrl, '/v1/me', token, MeResponse, opts)).person
}

/** `GET /v1/threads`: the person's threads, most recently updated first. */
export async function listThreads(
  baseUrl: string,
  token: string,
  opts: HttpOptions = {},
): Promise<ThreadDto[]> {
  return (await getJson(baseUrl, '/v1/threads', token, ThreadsResponse, opts)).threads
}

export type MessagesPageQuery = {
  /** Return the messages just before this one. Omit for the latest page. */
  before?: MessageId | undefined
  /** 1..200, default 50. */
  limit?: number | undefined
}

/** `GET /v1/threads/:id/messages`: one page of history, oldest first, plus `hasMore`. */
export async function listMessages(
  baseUrl: string,
  token: string,
  threadId: ThreadId,
  query: MessagesPageQuery = {},
  opts: HttpOptions = {},
): Promise<MessagesResponse> {
  const params = new URLSearchParams()
  if (query.before) params.set('before', query.before)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  const path = `/v1/threads/${encodeURIComponent(threadId)}/messages${qs}`
  return getJson(baseUrl, path, token, MessagesResponse, opts)
}

async function getJson<T>(
  baseUrl: string,
  path: string,
  token: string,
  schema: Schema<T>,
  opts: HttpOptions,
  method: 'GET' | 'POST' = 'GET',
): Promise<T> {
  const res = await send(baseUrl, path, opts, { method, headers: { authorization: `Bearer ${token}` } })
  const json = await readJson(res)
  if (!res.ok) throw httpError(res.status, json)
  return parseBody(schema, json, path)
}

async function send(baseUrl: string, path: string, opts: HttpOptions, init: RequestInit): Promise<Response> {
  const doFetch: Fetch = opts.fetch ?? ((input, reqInit) => fetch(input, reqInit))
  try {
    return await doFetch(`${baseUrl}${path}`, { ...init, signal: opts.signal ?? null })
  } catch (error) {
    if (opts.signal?.aborted) throw new ClientError('ABORTED', 'request aborted', { cause: error })
    throw new ClientError('NETWORK', `cannot reach ${baseUrl}`, { cause: error })
  }
}

function httpError(status: number, json: unknown): ClientError {
  const parsed = HttpErrorBody.safeParse(json)
  const detail = parsed.success ? parsed.data.error.message : `HTTP ${status}`
  if (status === 401) return new ClientError('UNAUTHORIZED', 'the session has expired, sign in again')
  if (status === 404) return new ClientError('NOT_FOUND', detail)
  return new ClientError('HTTP_ERROR', `request failed: ${detail}`)
}

function parseBody<T>(schema: Schema<T>, json: unknown, what: string): T {
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new ClientError('INVALID_RESPONSE', `the server sent an invalid ${what} response`)
  }
  return parsed.data
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    // A non-JSON body is reported by the caller as an invalid response or an HTTP status.
    return null
  }
}
