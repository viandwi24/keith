// Plugin HTTP routes and WS frame handlers. Contract: docs/contracts/plugin-api.md#http-and-ws-infra-client-app.
//
// Mount rules:
// - `route(method, path)` is mounted at `/p/<namespace><path>`. A path that already starts with
//   `/p/<namespace>` is taken as is. `/v1…` and another plugin's `/p/…` throw `ROUTE_CONFLICT`,
//   as does a second registration of the same method and path.
// - Path segments `:name` are parameters (`c.params.name`).
// - `static('/', dir)` is for `client-app` plugins only (`PLUGIN_KIND_VIOLATION` otherwise), and
//   only one plugin may own `/` (`ROUTE_CONFLICT`). Other mount paths go under `/p/<namespace>`.
// - WS frame types must start with `<namespace>.` (`PLUGIN_NAMESPACE_INVALID`); a type registered
//   twice throws `ROUTE_CONFLICT`.
// The plugin host enforces the kind table (which kinds may use `http` and `ws` at all).

import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { HttpHandler, HttpMethod, HttpRegistry, WsRegistry } from '@keith/sdk'
import { KeithError } from '@keith/sdk'
import type { PluginOwner, PluginScoped } from '../plugins/types.ts'
import type { PersonDto } from '../shared/types.ts'

type WsSchema = Parameters<WsRegistry['handle']>[1]
type WsHandler = Parameters<WsRegistry['handle']>[2]

type RouteEntry = {
  pluginId: string
  method: HttpMethod
  path: string
  segments: string[]
  auth: 'none' | 'bearer'
  handler: HttpHandler
}

type StaticEntry = { pluginId: string; mountPath: string; dir: string; spaFallback: string | undefined }

export type WsHandlerEntry = { pluginId: string; type: string; schema: WsSchema; handler: WsHandler }

/** How a route learns who is calling. Null = no valid bearer token. */
export type PersonResolver = (req: Request) => Promise<PersonDto | null>

export interface PluginHttp extends PluginScoped<HttpRegistry> {
  /** Answers a request outside `/v1`, or returns null when no plugin route or static file matches. */
  handle(req: Request, url: URL, resolvePerson: PersonResolver): Promise<Response | null>
}

export interface PluginWs extends PluginScoped<WsRegistry> {
  find(type: string): WsHandlerEntry | undefined
}

const splitPath = (path: string) => path.split('/').filter((s) => s.length > 0)

function mountedPath(namespace: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const base = `/p/${namespace}`
  if (p === '/v1' || p.startsWith('/v1/')) {
    throw new KeithError('ROUTE_CONFLICT', `'${path}' is under /v1, which is reserved for the core`)
  }
  let full: string
  if (p === base || p.startsWith(`${base}/`)) full = p
  else if (p === '/p' || p.startsWith('/p/')) {
    throw new KeithError('ROUTE_CONFLICT', `'${path}' is outside the plugin's mount ${base}`)
  } else full = p === '/' ? base : `${base}${p}`
  return full.length > 1 && full.endsWith('/') ? full.slice(0, -1) : full
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (const [i, part] of pattern.entries()) {
    const value = actual[i] ?? ''
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(value)
      } catch {
        // Malformed percent-encoding: the path does not match any route.
        return null
      }
    } else if (part !== value) return null
  }
  return params
}

const unauthorized = () =>
  Response.json({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } }, { status: 401 })

async function serveStatic(entry: StaticEntry, pathname: string): Promise<Response | null> {
  const rel = entry.mountPath === '/' ? pathname : pathname.slice(entry.mountPath.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    // Malformed percent-encoding: treated as not found.
    return null
  }
  const root = resolve(entry.dir)
  const candidates = [decoded === '' || decoded.endsWith('/') ? `${decoded}/index.html` : decoded]
  if (entry.spaFallback !== undefined) candidates.push(`/${entry.spaFallback}`)
  for (const candidate of candidates) {
    const file = resolve(root, `.${candidate}`)
    if (file !== root && !file.startsWith(root + sep)) continue
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) return new Response(Bun.file(file))
  }
  return null
}

export function createPluginHttp(): PluginHttp {
  const routes: RouteEntry[] = []
  const statics: StaticEntry[] = []

  return {
    forPlugin(owner: PluginOwner): HttpRegistry {
      return {
        route(method, path, handler, opts) {
          const full = mountedPath(owner.namespace, path)
          if (routes.some((r) => r.method === method && r.path === full)) {
            throw new KeithError('ROUTE_CONFLICT', `${method} ${full} is already registered`)
          }
          routes.push({
            pluginId: owner.pluginId,
            method,
            path: full,
            segments: splitPath(full),
            auth: opts?.auth ?? 'bearer',
            handler,
          })
        },
        static(mountPath, dir, opts) {
          let mount: string
          if (mountPath === '/') {
            if (owner.kind !== 'client-app') {
              throw new KeithError('PLUGIN_KIND_VIOLATION', `only client-app plugins may serve '/'`)
            }
            mount = '/'
          } else mount = mountedPath(owner.namespace, mountPath)
          if (statics.some((s) => s.mountPath === mount)) {
            throw new KeithError('ROUTE_CONFLICT', `static mount ${mount} is already taken`)
          }
          statics.push({ pluginId: owner.pluginId, mountPath: mount, dir, spaFallback: opts?.spaFallback })
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const list of [routes, statics] as { pluginId: string }[][]) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i]?.pluginId === pluginId) list.splice(i, 1)
      }
    },
    async handle(req, url, resolvePerson) {
      const actual = splitPath(url.pathname)
      for (const route of routes) {
        if (route.method !== req.method) continue
        const params = matchSegments(route.segments, actual)
        if (!params) continue
        const person = await resolvePerson(req)
        if (route.auth === 'bearer' && !person) return unauthorized()
        return await route.handler(req, { person, params })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return null
      // Longest mount first, so `/p/web/assets` wins over `/`.
      const ordered = [...statics].sort((a, b) => b.mountPath.length - a.mountPath.length)
      for (const entry of ordered) {
        const inside =
          entry.mountPath === '/' ||
          url.pathname === entry.mountPath ||
          url.pathname.startsWith(`${entry.mountPath}/`)
        if (!inside) continue
        const response = await serveStatic(entry, url.pathname)
        if (response) return response
      }
      return null
    },
  }
}

export function createPluginWs(): PluginWs {
  const handlers = new Map<string, WsHandlerEntry>()
  return {
    forPlugin(owner: PluginOwner): WsRegistry {
      return {
        handle(type, schema, handler) {
          if (!type.startsWith(`${owner.namespace}.`) || type.length === owner.namespace.length + 1) {
            throw new KeithError(
              'PLUGIN_NAMESPACE_INVALID',
              `ws frame type '${type}' must start with '${owner.namespace}.'`,
            )
          }
          if (handlers.has(type)) throw new KeithError('ROUTE_CONFLICT', `ws frame type '${type}' is taken`)
          handlers.set(type, { pluginId: owner.pluginId, type, schema, handler })
        },
      }
    },
    removeByPlugin(pluginId) {
      for (const [type, entry] of handlers) if (entry.pluginId === pluginId) handlers.delete(type)
    },
    find: (type) => handlers.get(type),
  }
}
