// The core's `/v1` HTTP endpoints. Contract: docs/contracts/protocol.md#http-endpoints.

import {
  type HealthResponse,
  InviteAcceptRequest,
  LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MessageDto,
  MessagesQuery,
  type MessagesResponse,
  PASSWORD_MIN_CHARS,
  PROTOCOL_VERSION,
  type ThreadDto,
  ThreadId,
  type ThreadsResponse,
} from '@keith/protocol'
import type { ThreadManager } from '../mind/types.ts'
import type { Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import { type Auth, type AuthSession, bearerToken } from './auth.ts'
import { toMessageDto, toPersonDto } from './dto.ts'
import type { FilesApi } from './files.ts'
import { errorResponse } from './responses.ts'
import { createThreadDescriber } from './thread-list.ts'

export { errorResponse }

export type HttpApiDeps = {
  auth: Auth
  repos: Pick<Repositories, 'persons' | 'threads' | 'messages'>
  threads: Pick<ThreadManager, 'state'>
  files: FilesApi
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

const FILE_PATH = /^\/v1\/files\/[^/]+$/

/** Handles every `/v1/*` request except the WS upgrade. */
export function createHttpApi(deps: HttpApiDeps): (req: Request, url: URL) => Promise<Response> {
  const { auth, repos } = deps

  const threadsOf = async (session: AuthSession): Promise<ThreadDto[]> => {
    const describe = createThreadDescriber(deps)
    const out: ThreadDto[] = []
    for (const t of await repos.threads.listForPerson(session.person.id)) {
      const dto = await describe(t)
      if (dto) out.push(dto)
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

    if (path === '/v1/auth/invite' && method === 'POST') {
      const json = await readJson(req)
      if (!json.ok) return errorResponse('INVALID_REQUEST', 'body is not valid JSON')
      const parsed = InviteAcceptRequest.safeParse(json.value)
      if (!parsed.success) {
        return errorResponse(
          'INVALID_REQUEST',
          `expected { code, username, password } with a password of at least ${PASSWORD_MIN_CHARS} characters`,
        )
      }
      const result = await auth.acceptInvite(parsed.data)
      if (!result.ok) return errorResponse(result.code, result.message)
      const body: LoginResponse = result.login
      return Response.json(body)
    }

    const known =
      (path === '/v1/auth/logout' && method === 'POST') ||
      ((path === '/v1/me' || path === '/v1/threads') && method === 'GET') ||
      (/^\/v1\/threads\/[^/]+\/messages$/.test(path) && method === 'GET') ||
      (path === '/v1/files' && method === 'POST') ||
      (FILE_PATH.test(path) && method === 'GET')
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
    if (path === '/v1/files') return deps.files.upload(req, session.person.id)
    const rawId = path.split('/')[3] ?? ''
    if (FILE_PATH.test(path)) return deps.files.download(rawId, session.person.id)
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
