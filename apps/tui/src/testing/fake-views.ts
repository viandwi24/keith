import type { ViewMenu } from '@keith/contracts'
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'

/** Plugin terminal views of the fake core (`/plugins/tui/menu` and `/plugins/views/ws`). */
export interface FakeViewsOptions {
  menu: ViewMenu['items']
  /** The first frame of a view (default: its id and size). */
  frame?: (hello: FakeHello) => string
}

export interface FakeHello {
  viewId: string
  cols: number
  rows: number
  colorDepth: number
}

export interface FakeViews {
  /** `hello` messages seen, `key` data in order and `resize` sizes in order. */
  hellos: FakeHello[]
  keys: string[]
  resizes: Array<{ cols: number; rows: number }>
  /** The `authorization` header of each upgrade (`null` on the socket). */
  auth: Array<string | null>
  /** How many times the menu was read (`GET /plugins/tui/menu`). */
  menuReads: number
  /** How many `close` messages the panel sent. */
  closes: number
  /** Sockets open now. */
  sockets(): number
  /** Send a frame (the text as the core would: SGR and nothing else, or anything a hostile view prints). */
  frame(text: string): void
  /** The view ended: `closed { reason }` and the socket closes. */
  end(reason: string): void
  /** The connection dies without a word. */
  drop(): void
}

type Data = undefined

export function createFakeViews(options: FakeViewsOptions): {
  views: FakeViews
  /** `undefined`: not a view route; `'upgraded'`: the upgrade took the request; else a `Response`. */
  handle(request: Request, url: URL, server: Server<Data>): Response | 'upgraded' | undefined
  websocket: WebSocketHandler<Data>
} {
  let socket: ServerWebSocket<Data> | undefined
  let seq = 0
  let open = 0
  const views: FakeViews = {
    hellos: [],
    keys: [],
    resizes: [],
    auth: [],
    menuReads: 0,
    closes: 0,
    sockets: () => open,
    frame: (text) => socket?.send(JSON.stringify({ type: 'frame', seq: ++seq, text })),
    end: (reason) => {
      socket?.send(JSON.stringify({ type: 'closed', reason }))
      socket?.close(1000, reason)
    },
    drop: () => socket?.terminate(),
  }
  return {
    views,
    handle(request, url, server) {
      if (url.pathname === '/plugins/tui/menu') {
        views.menuReads++
        return Response.json({ items: options.menu })
      }
      if (url.pathname !== '/plugins/views/ws') return undefined
      views.auth.push(request.headers.get('authorization'))
      return server.upgrade(request, { data: undefined })
        ? 'upgraded'
        : new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(ws) {
        socket = ws
        open++
      },
      close() {
        open--
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as Record<string, unknown> & { type: string }
        if (m.type === 'hello') {
          const hello = m as unknown as FakeHello
          views.hellos.push(hello)
          ws.send(JSON.stringify({ v: 1, type: 'ready', cols: hello.cols, rows: hello.rows }))
          views.frame(options.frame?.(hello) ?? `${hello.viewId} ${hello.cols}x${hello.rows}`)
        } else if (m.type === 'key') {
          views.keys.push(String(m.data))
          views.frame(`keys ${JSON.stringify(views.keys)}`)
        } else if (m.type === 'resize') {
          views.resizes.push({ cols: Number(m.cols), rows: Number(m.rows) })
          views.frame(`size ${m.cols}x${m.rows}`)
        } else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
        else if (m.type === 'close') {
          views.closes++
          ws.send(JSON.stringify({ type: 'closed', reason: 'view' }))
          ws.close(1000, 'view')
        }
      },
    },
  }
}
