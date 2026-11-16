/**
 * Public resources for plugin pages through the core (docs/specs/thalamus.md, "Plugin net route"; docs/specs/net-proxy.md).
 * `GET /plugins/<id>/net/<host>/<path>` fetches `https://<host>/<path>` with the core's net proxy, only when `<host>` is an origin one
 * of the plugin's window apps declared in `network`, and only images. A sandboxed page then loads e.g. map tiles from its own core:
 * the upstream sees Keith's User-Agent and a cached, rate-limited client, whatever the browser would have sent.
 */
import type { NetProxy } from '../../platform/net-proxy.ts'

export interface PluginNetDeps {
  proxy: NetProxy
  contributions: (
    point: string,
  ) => readonly { point: string; contributor: string; id: string; entry: unknown }[]
}

export interface PluginNet {
  serve(request: Request): Promise<Response>
}

const POINT = 'web.window'
const PATH =
  /^\/plugins\/([a-z0-9-]{1,24})\/net\/([a-z0-9.-]{1,253}(?::\d{1,5})?)\/([A-Za-z0-9._~@=,+\-/]{1,512})$/

/** The image types relayed. SVG is left out: it can carry script when opened as a page. */
export const NET_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']

const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0) =>
  bytes.every((x, i) => b[at + i] === x)

/** The image type of a file from its first bytes (for a host that sends images as `application/octet-stream`), else undefined. */
export function sniffImage(b: Uint8Array): string | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4)) return 'image/avif'
  return undefined
}

/** How long a live image (an origin in an app's `live`) is kept by the core. */
export const LIVE_MS = 20_000

/** Whether a path is a plugin net path (no principal is resolved for it, like a bundle file). */
export const isPluginNetPath = (path: string): boolean => PATH.test(path)

const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  })

export function createPluginNet(deps: PluginNetDeps): PluginNet {
  /** The hosts (`name[:port]`) the plugin's window apps declared in `network` (or in `live`). */
  const hostsOf = (pluginId: string, field: 'network' | 'live' = 'network'): Set<string> => {
    const hosts = new Set<string>()
    for (const c of deps.contributions(POINT)) {
      if (c.contributor !== pluginId) continue
      const list = (c.entry as Record<string, unknown>)[field]
      if (!Array.isArray(list)) continue
      for (const origin of list) {
        if (typeof origin !== 'string') continue
        try {
          const u = new URL(origin)
          if (u.protocol === 'https:') hosts.add(u.host)
        } catch {
          // a malformed origin never matches
        }
      }
    }
    return hosts
  }

  return {
    async serve(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return text(405, 'method not allowed')
      let path: string
      try {
        // the query is dropped: only the path reaches upstream
        path = new URL(request.url).pathname
      } catch {
        return text(404, 'not found')
      }
      const match = PATH.exec(path)
      if (match === null) return text(404, 'not found')
      const [, pluginId = '', host = '', rest = ''] = match
      if (rest.split('/').some((part) => part === '' || part === '.' || part === '..'))
        return text(404, 'not found')
      if (!hostsOf(pluginId).has(host)) return text(404, 'not found')
      // a live image (a camera frame) must be in `network` too, which was checked above
      const live = hostsOf(pluginId, 'live').has(host)
      const got = await deps.proxy.get(
        `https://${host}/${rest}`,
        NET_IMAGE_TYPES,
        live ? { liveMs: LIVE_MS, sniff: sniffImage } : { sniff: sniffImage },
      )
      if (!got.ok) return text(got.status, got.reason)
      return new Response(request.method === 'HEAD' ? null : got.body, {
        headers: {
          'content-type': got.type,
          'cache-control': live ? 'no-cache' : 'public, max-age=86400',
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'access-control-allow-origin': '*',
          'x-keith-cache': got.from,
        },
      })
    },
  }
}
