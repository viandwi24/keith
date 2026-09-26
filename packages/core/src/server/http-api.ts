// The core's `/v1` HTTP endpoints. Contract: docs/contracts/protocol.md#http-endpoints.

import {
  type ErrorCode,
  type HealthResponse,
  type HttpErrorBody,
  LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MessageDto,
  MessagesQuery,
  type MessagesResponse,
  PROTOCOL_VERSION,
  type ThreadDto,
  ThreadId,
  type ThreadsResponse,
} from '@keith/protocol'
import type { ThreadManager } from '../mind/types.ts'
import type { Logger, PersonDto, PersonId } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import { type Auth, type AuthSession, bearerToken } from './auth.ts'
import { toMessageDto, toPersonDto, toThreadDto } from './dto.ts'

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_FRAME: 400,
  UNKNOWN_FRAME: 400,
  THREAD_BUSY: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
}

export function errorResponse(code: ErrorCode, message: string): Response {
  const body: HttpErrorBody = { error: { code, message } }
  return Response.json(body, { status: STATUS[code] })
}

export type HttpApiDeps = {
  auth: Auth
  repos: Pick<Repositories, 'persons' | 'threads' | 'messages'>
  threads: Pick<ThreadManager, 'state'>
  version: string
  log: Logger
}

/** Resolves the bearer token of a request, or null. */
export async function sessionOf(auth: Auth, req: Request): Promise<AuthSession | null> {
  const token = bearerToken(req)
  return token ? auth.resolve(token) : null
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await req.json() }
  } catch {
    // Converted into a documented 400 INVALID_REQUEST by the caller (R-11).
    return { ok: false }
  }
}

/** Handles every `/v1/*` request except the WS upgrade. */
export function createHttpApi(deps: HttpApiDeps): (req: Request, url: URL) => Promise<Response> {
  const { auth, repos } = deps

  const personsById = async (ids: PersonId[], cache: Map<PersonId, PersonDto | null>) => {
    const out: PersonDto[] = []
    for (const id of ids) {
      if (!cache.has(id)) {
        const p = await repos.persons.get(id)
        cache.set(id, p ? toPersonDto(p) : null)
      }
      const dto = cache.get(id)
      if (dto) out.push(dto)
    }
    return out
  }

  const threadsOf = async (session: AuthSession): Promise<ThreadDto[]> => {
    const cache = new Map<PersonId, PersonDto | null>()
    const records = await repos.threads.listForPerson(session.person.id)
    const out: ThreadDto[] = []
    for (const t of records) {
      const participants = await repos.threads.participants(t.id)
      const people = await personsById(
        participants.map((p) => p.personId),
        cache,
      )
      if (people.length === 0) continue
      out.push(toThreadDto(t, people, deps.threads.state(t.id)))
    }
    return out
  }

  const messagesOf = async (session: AuthSession, rawId: string, url: URL): Promise<Response> => {
    const id = ThreadId.safeParse(rawId)
    if (!id.success) return errorResponse('NOT_FOUND', 'thread not found')
    const participants = await repos.threads.participants(id.data)
    // A thread the caller is not part of looks the same as a missing one.
    if (!participants.some((p) => p.personId === session.person.id)) {
      return errorResponse('NOT_FOUND', 'thread not found')
    }
    const query = MessagesQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success)
      return errorResponse('INVALID_REQUEST', query.error.issues[0]?.message ?? 'invalid query')
    const page = await repos.messages.page({
      threadId: id.data,
      before: query.data.before,
      limit: query.data.limit,
      roles: ['user', 'assistant'],
    })
    const messages = page.messages.map(toMessageDto).filter((m): m is MessageDto => m !== null)
    const body: MessagesResponse = { messages, hasMore: page.hasMore }
    return Response.json(body)
  }

  const route = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname
    const method = req.method

    if (path === '/v1/health' && method === 'GET') {
      const body: HealthResponse = { ok: true, version: deps.version, protocol: PROTOCOL_VERSION }
      return Response.json(body)
    }

    if (path === '/v1/auth/login' && method === 'POST') {
      const json = await readJson(req)
      if (!json.ok) return errorResponse('INVALID_REQUEST', 'body is not valid JSON')
      const parsed = LoginRequest.safeParse(json.value)
      if (!parsed.success) return errorResponse('INVALID_REQUEST', 'expected { username, password }')
      const result = await auth.login(parsed.data.username, parsed.data.password)
      if (!result) return errorResponse('UNAUTHORIZED', 'invalid username or password')
      const body: LoginResponse = result
      return Response.json(body)
    }

    const known =
      (path === '/v1/auth/logout' && method === 'POST') ||
      ((path === '/v1/me' || path === '/v1/threads') && method === 'GET') ||
      (/^\/v1\/threads\/[^/]+\/messages$/.test(path) && method === 'GET')
    if (!known) return errorResponse('NOT_FOUND', `no route for ${method} ${path}`)

    const session = await sessionOf(auth, req)
    if (!session) return errorResponse('UNAUTHORIZED', 'missing or invalid token')

    if (path === '/v1/auth/logout') {
      await auth.logout(session.tokenHash)
      return Response.json({ ok: true })
    }
    if (path === '/v1/me') {
      const body: MeResponse = { person: toPersonDto(session.person) }
      return Response.json(body)
    }
    if (path === '/v1/threads') {
      const body: ThreadsResponse = { threads: await threadsOf(session) }
      return Response.json(body)
    }
    const rawId = path.split('/')[3] ?? ''
    return messagesOf(session, rawId, url)
  }

  return async (req, url) => {
    try {
      return await route(req, url)
    } catch (error) {
      deps.log.error('http request failed', { method: req.method, path: url.pathname, error: String(error) })
      return errorResponse('INTERNAL', 'internal error')
    }
  }
}
