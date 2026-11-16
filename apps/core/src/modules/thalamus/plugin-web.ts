/**
 * Static web bundles of plugins at `/plugins/<id>/web/*` (docs/specs/thalamus.md, "Plugin web bundles"; ADR-0038 §5). Files come
 * only from the folder the loaded plugin's manifest names (`web.dir`); no plugin code runs. Every answer carries a CSP built from the
 * `network` of the window app it belongs to, so a page loads images from and connects to its declared origins only.
 */
import { realpath, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

/** What the route needs of the plugin host: the loaded plugins and the contributions to a point. */
export interface PluginWebDeps {
  plugins: () => readonly {
    id: string
    manifest: { web?: { dir: string; mounts?: Record<string, string> } | undefined }
  }[]
  contributions: (
    point: string,
  ) => readonly { point: string; contributor: string; id: string; entry: unknown }[]
}

export interface PluginWeb {
  /** Answers a request of `/plugins/<id>/web/*`; anything else under it is 404. */
  serve(request: Request): Promise<Response>
}

const POINT = 'web.window'
const PATH = /^\/plugins\/([a-z0-9-]{1,24})\/web\/(.+)$/

/** Whether a path is a plugin bundle file (no principal is resolved for it, like `/app`). */
export const isPluginWebPath = (path: string): boolean => PATH.test(path)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
}

/** What a page's app opens beyond the strict policy (ADR-0040). */
export interface PageOptions {
  /** A 3D app: workers from `blob:`, WebAssembly, and fetches to `<core>/plugins/<id>/`. */
  gpu?: boolean
  /** Audio from any https origin. */
  media?: boolean
  /** The plugin whose paths a `gpu` page may fetch. */
  pluginId?: string
}

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/

const CORE_ORIGIN = /^https?:\/\/[a-z0-9.\-[\]:]+$/i

/**
 * The CSP of a bundle file whose app may reach `network` (https origins). `core` is the core's own origin, written next to `'self'`:
 * the page runs in a sandboxed iframe with an opaque origin, and WebKit then matches `'self'` against nothing, so the page's own
 * script and style would be refused (Chrome matches the URL's origin). The Host was already checked (a foreign one answers 421).
 */
export function pluginContentSecurityPolicy(
  network: readonly string[],
  core?: string,
  page: PageOptions = {},
): string {
  const origins = [...new Set(network.filter((o) => HTTPS_ORIGIN.test(o)))]
  const coreOk = core !== undefined && CORE_ORIGIN.test(core)
  const self = coreOk ? `'self' ${core}` : "'self'"
  const own =
    page.gpu === true && coreOk && page.pluginId !== undefined && PLUGIN_ID.test(page.pluginId)
      ? [`${core}/plugins/${page.pluginId}/`]
      : []
  const connect = [...own, ...origins]
  const list = origins.join(' ')
  const out = [
    "default-src 'none'",
    `script-src ${self}${page.gpu === true ? " 'wasm-unsafe-eval'" : ''}`,
    `style-src ${self}`,
    `img-src ${self}${page.gpu === true ? ' blob: data:' : ''}${list === '' ? '' : ` ${list}`}`,
    `connect-src ${connect.length === 0 ? "'none'" : connect.join(' ')}`,
  ]
  // a module worker's static imports are checked against worker-src, not script-src: the engine's worker files (its own) are allowed;
  // an opaque-origin frame can start a module worker only from `data:` (a `blob:null` module worker never loads), classic ones from `blob:`
  if (page.gpu === true) out.push(`worker-src ${self} blob: data:`)
  if (page.media === true) out.push('media-src https:')
  out.push("frame-ancestors 'self'")
  return out.join('; ')
}

const PLUGIN_ID = /^[a-z0-9-]{1,24}$/

const textHeaders = (csp: string): Headers =>
  new Headers({
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })

export function createPluginWeb(deps: PluginWebDeps): PluginWeb {
  const strict = pluginContentSecurityPolicy([])
  const notFound = () => new Response('not found\n', { status: 404, headers: textHeaders(strict) })

  /**
   * The network and options of the page `rel` (relative to the web folder), or the union of the plugin's apps' networks for any other
   * file (a script's own CSP only matters for a worker, and a `gpu` page starts its workers from `blob:` under the page's policy).
   */
  const pageOf = (pluginId: string, rel: string): { network: string[]; page: PageOptions } => {
    const apps = deps
      .contributions(POINT)
      .filter((c) => c.contributor === pluginId)
      .map(
        (c) =>
          c.entry as {
            entry?: { path?: unknown }
            network?: unknown
            gpu?: unknown
            media?: unknown
          },
      )
    const networks = (app: (typeof apps)[number]): string[] =>
      Array.isArray(app.network) ? app.network.filter((o) => typeof o === 'string') : []
    if (rel.endsWith('.html')) {
      const app = apps.find((a) => a.entry?.path === `./web/${rel}`)
      if (app === undefined) return { network: [], page: {} }
      return {
        network: networks(app),
        page: { gpu: app.gpu === true, media: app.media === true, pluginId },
      }
    }
    return { network: apps.flatMap(networks), page: {} }
  }

  /** The real path of a regular file under `root`, or undefined (missing, a directory, outside the folder, a symlink out). */
  const fileUnder = async (root: string, rel: string): Promise<string | undefined> => {
    if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return undefined
    if (rel.split('/').some((part) => part === '..' || part === '.' || part === ''))
      return undefined
    const base = normalize(root)
    const target = normalize(join(base, rel))
    if (!target.startsWith(base + sep)) return undefined
    try {
      const [real, realRoot] = await Promise.all([realpath(target), realpath(base)])
      if (!real.startsWith(realRoot + sep)) return undefined
      return (await stat(real)).isFile() ? real : undefined
    } catch {
      return undefined
    }
  }

  const csp = (pluginId: string, rel: string, core: string): string => {
    const { network, page } = pageOf(pluginId, rel)
    return pluginContentSecurityPolicy(network, core, page)
  }

  return {
    async serve(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const headers = textHeaders(strict)
        headers.set('allow', 'GET, HEAD')
        return new Response('method not allowed\n', { status: 405, headers })
      }
      let path: string
      let core: string
      try {
        const url = new URL(request.url)
        path = decodeURIComponent(url.pathname)
        core = url.origin
      } catch {
        return notFound()
      }
      const match = PATH.exec(path)
      if (match === null) return notFound()
      const [, pluginId = '', rel = ''] = match
      const web = deps.plugins().find((p) => p.id === pluginId)?.manifest.web
      if (web === undefined) return notFound()
      const type = TYPES[extname(rel).toLowerCase()]
      if (type === undefined) return notFound()
      // a mounted folder (`vendor/<name>/...`) answers from its own root; only the bundle folder holds pages
      const mount = Object.entries(web.mounts ?? {}).find(([name]) => rel.startsWith(`${name}/`))
      if (mount !== undefined && rel.endsWith('.html')) return notFound()
      const found =
        mount === undefined
          ? await fileUnder(web.dir, rel)
          : await fileUnder(mount[1], rel.slice(mount[0].length + 1))
      if (found === undefined) return notFound()
      return new Response(request.method === 'HEAD' ? null : Bun.file(found), {
        headers: {
          'content-type': type,
          'content-security-policy': csp(pluginId, rel, core),
          'x-content-type-options': 'nosniff',
          // a mounted library is a fixed release: a day of cache spares the 6 MB engine on every open
          'cache-control': mount === undefined ? 'no-cache' : 'public, max-age=86400',
          'referrer-policy': 'no-referrer',
          // the page runs in a sandboxed iframe with an opaque origin: its module scripts and fonts are CORS requests
          // from `null`. The files are public and the answer never depends on a cookie, so any origin may read them.
          'access-control-allow-origin': '*',
        },
      })
    },
  }
}
