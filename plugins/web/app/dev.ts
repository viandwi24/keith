/**
 * Dev server for the browser app (ADR-0012): Bun's fullstack dev server bundles `index.html` on
 * request with hot reloading, and forwards `/v1/*` (HTTP and the `/v1/ws` WebSocket) to a running
 * core, so the app talks to the core from its own origin exactly as it does when the core serves it.
 *
 * Usage: bun run dev   (from plugins/web)   Env: KEITH_URL (default http://127.0.0.1:4824), PORT (5173)
 */
import type { Server, ServerWebSocket } from 'bun'
import index from './index.html'

const core = new URL(process.env.KEITH_URL ?? 'http://127.0.0.1:4824')
const port = Number(process.env.PORT ?? 5173)

type Frame = string | Uint8Array<ArrayBuffer>
type Upstream = { path: string; upstream: WebSocket | null; queue: Frame[] }

function coreUrl(req: Request, protocol?: 'ws:' | 'wss:'): URL {
  const url = new URL(req.url)
  const target = new URL(url.pathname + url.search, core)
  if (protocol) target.protocol = protocol
  return target
}

async function proxy(req: Request): Promise<Response> {
  const headers = new Headers(req.headers)
  headers.delete('host')
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer()
  try {
    return await fetch(coreUrl(req), { method: req.method, headers, body, redirect: 'manual' })
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'INTERNAL',
          message: `dev proxy: core at ${core.origin} unreachable (${String(error)})`,
        },
      },
      { status: 502 },
    )
  }
}

const server = Bun.serve<Upstream>({
  port,
  development: { hmr: true, console: true },
  routes: {
    '/v1/ws': (req: Request, srv: Server<Upstream>) => {
      const url = new URL(req.url)
      if (srv.upgrade(req, { data: { path: url.pathname + url.search, upstream: null, queue: [] } })) {
        return undefined
      }
      return new Response('upgrade failed', { status: 400 })
    },
    '/v1/*': proxy,
    '/*': index,
  },
  websocket: {
    open(ws: ServerWebSocket<Upstream>) {
      const target = new URL(ws.data.path, core)
      target.protocol = core.protocol === 'https:' ? 'wss:' : 'ws:'
      const upstream = new WebSocket(target)
      upstream.binaryType = 'arraybuffer'
      ws.data.upstream = upstream
      upstream.addEventListener('open', () => {
        for (const message of ws.data.queue) upstream.send(message)
        ws.data.queue = []
      })
      upstream.addEventListener('message', (event) => {
        ws.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      })
      upstream.addEventListener('close', (event) => ws.close(event.code, event.reason))
    },
    message(ws, message) {
      const upstream = ws.data.upstream
      const data: Frame = typeof message === 'string' ? message : Uint8Array.from(message)
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
      else ws.data.queue.push(data)
    },
    close(ws, code, reason) {
      const upstream = ws.data.upstream
      if (upstream && upstream.readyState <= WebSocket.OPEN) {
        // 1005/1006 cannot be sent; close normally instead.
        upstream.close(code >= 3000 || code === 1000 ? code : 1000, reason)
      }
    },
  },
})

console.log(`keith web dev server: ${server.url} (core: ${core.origin})`)
