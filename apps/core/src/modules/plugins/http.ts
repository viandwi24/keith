import {
  buildOpenApi,
  GUARD_STATUS,
  GuardError,
  isReviewTicket,
  type ResolvedOperation,
} from '@keith/host'
import type { Principal, Via } from '../auth/index.ts'
import type { PluginHost } from './host.ts'

/** What thalamus knows about the request and hands over (`createApp` resolved the bearer). */
export interface PluginRequestContext {
  principal: Principal | undefined
  via: Via
}

export interface PluginRoutes {
  handle(request: Request, context: PluginRequestContext): Promise<Response>
}

/** Largest JSON body of an operation call. */
export const PLUGIN_BODY_MAX_BYTES = 64 * 1024

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const errorBody = (code: string, message: string) => ({ error: { code, message } })
const NOT_FOUND = (): Response => {
  const e = new GuardError('NOT_FOUND', 'route')
  return json(404, errorBody(e.code, e.message))
}

/**
 * `/plugins/*` for thalamus: `POST /plugins/<id>/<op>` runs an operation through **the same guard** as the AI tool,
 * `GET /plugins/openapi.json` describes the operations the caller may see and `GET /plugins/tui/menu` lists the terminal views the caller may open. A path that is not an operation, a disabled
 * plugin, an operation not exposed over HTTP, a wrong method and a denial are all one `404` with one body.
 */
export function createPluginRoutes(options: { host: PluginHost }): PluginRoutes {
  const { host } = options
  return {
    async handle(request, { principal, via }) {
      if (principal === undefined)
        return json(401, errorBody('UNAUTHORIZED', 'missing or invalid token'))
      const parts = new URL(request.url).pathname.split('/').filter((p) => p !== '')
      // parts[0] is `plugins`
      const principalRef = { id: principal.personId }

      if (parts.length === 2 && parts[1] === 'openapi.json' && request.method === 'GET') {
        const ops = await host.visibleOperations(principalRef.id, 'http')
        return json(200, buildOpenApi(ops))
      }
      // the terminal menu of this caller (ADR-0018): the views of loaded plugins the actor may open
      if (
        parts.length === 3 &&
        parts[1] === 'tui' &&
        parts[2] === 'menu' &&
        request.method === 'GET'
      )
        return json(200, { items: await host.views.menu(principalRef.id) })
      if (parts.length !== 3 || request.method !== 'POST') return NOT_FOUND()

      // the size check applies to every operation path alike, so it tells nothing about which exist
      const text = await request.text()
      if (new TextEncoder().encode(text).length > PLUGIN_BODY_MAX_BYTES)
        return json(413, errorBody('PAYLOAD_TOO_LARGE', 'the request body is too large'))
      const op: ResolvedOperation | undefined = host
        .loaded()
        .find((p) => p.id === parts[1])
        ?.operation(parts[2] ?? '')
      if (op === undefined || !op.expose.http) return NOT_FOUND()

      // a body that is not JSON is passed on as "no input": the guard refuses a caller who may not use the
      // operation with the standard 404 first, and only an allowed caller learns the input is bad
      let input: unknown
      try {
        input = text === '' ? {} : JSON.parse(text)
      } catch {
        input = undefined
      }
      try {
        const output = await host.guard.run(op, input, {
          principal: principalRef,
          session: {
            id: null,
            kind: 'api',
            method: principal.credential?.methods?.[0] ?? (via === 'local' ? 'local' : null),
            elevated: principal.elevated === true,
          },
          signal: request.signal,
        })
        // an operation held for the owner's review answers 202 with its ticket
        return json(isReviewTicket(output) ? 202 : 200, output)
      } catch (error) {
        if (error instanceof GuardError) {
          return json(GUARD_STATUS[error.code], errorBody(error.code, error.message), {
            ...(error.retryAfterMs === undefined
              ? {}
              : { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) }),
          })
        }
        return json(500, errorBody('INTERNAL', 'the operation failed'))
      }
    },
  }
}
