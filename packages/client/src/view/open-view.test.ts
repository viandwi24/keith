import { afterEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import { createKeithClient } from '../client.ts'
import { ViewMenuError } from './menu.ts'
import { type OpenViewOptions, openView, type ViewEndReason } from './open-view.ts'
import type { ParsedFrame } from './parse-frame.ts'

const ESC = '\u001b'
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await wait(5)
  }
}

interface FakeCore {
  server: Server<undefined>
  url: string
  /** What the client sent, parsed, in order. */
  received: Array<Record<string, unknown>>
  headers: Headers[]
  urls: string[]
  /** The live socket. */
  socket(): ServerWebSocket<undefined> | undefined
  /** Replies to each message; the default speaks the protocol. */
  onMessage: (ws: ServerWebSocket<undefined>, message: Record<string, unknown>) => void
  refuse: boolean
}

const servers: Server<undefined>[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function fakeCore(): FakeCore {
  let live: ServerWebSocket<undefined> | undefined
  const core: FakeCore = {
    received: [],
    headers: [],
    urls: [],
    refuse: false,
    socket: () => live,
    onMessage: (ws, m) => {
      if (m.type === 'hello')
        ws.send(JSON.stringify({ v: 1, type: 'ready', cols: m.cols, rows: m.rows }))
      else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      else if (m.type === 'close') {
        ws.send(JSON.stringify({ type: 'closed', reason: 'view' }))
        ws.close(1000, 'view')
      }
    },
    server: undefined as never,
    url: '',
  }
  core.server = Bun.serve<undefined>({
    port: 0,
    fetch(request, server) {
      core.headers.push(request.headers)
      core.urls.push(request.url)
      if (core.refuse) return new Response('{"error":{"code":"UNAUTHORIZED"}}', { status: 401 })
      return server.upgrade(request, { data: undefined })
        ? undefined
        : new Response('no', { status: 426 })
    },
    websocket: {
      open(ws) {
        live = ws
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as Record<string, unknown>
        core.received.push(message)
        core.onMessage(ws, message)
      },
    },
  })
  servers.push(core.server)
  core.url = `http://127.0.0.1:${core.server.port}`
  return core
}

interface Run {
  frames: ParsedFrame[]
  statuses: string[]
  ends: ViewEndReason[]
  view: ReturnType<typeof openView>
}
function open(core: { url: string }, extra: Partial<OpenViewOptions> = {}): Run {
  const run = { frames: [], statuses: [], ends: [] } as unknown as Run
  run.view = openView({
    core: core.url,
    credential: 'keith_s_secret',
    viewId: 'notes.list',
    cols: 80,
    rows: 24,
    onFrame: (f) => run.frames.push(f),
    onStatus: (s) => run.statuses.push(s),
    onEnd: (r) => run.ends.push(r),
    ...extra,
  })
  return run
}
const frame = (ws: ServerWebSocket<undefined>, seq: number, text: string, more = false) =>
  ws.send(JSON.stringify({ type: 'frame', seq, text, ...(more ? { more: true } : {}) }))

describe('connecting', () => {
  test('hello carries the view and size; the bearer is in a header, never in the URL', async () => {
    const core = fakeCore()
    const run = open(core, { colorDepth: 8, params: { id: 'n1' } })
    await until(() => run.statuses.includes('open'))
    expect(run.statuses).toEqual(['connecting', 'open'])
    expect(core.received[0]).toEqual({
      v: 1,
      type: 'hello',
      viewId: 'notes.list',
      cols: 80,
      rows: 24,
      colorDepth: 8,
      params: { id: 'n1' },
    })
    expect(core.headers[0]?.get('authorization')).toBe('Bearer keith_s_secret')
    expect(core.urls[0]).not.toContain('keith_s_secret')
    expect(core.urls[0]).toContain('/plugins/views/ws')
    run.view.close()
    await until(() => run.ends.length > 0)
  })

  test('a core that is down is unavailable; a refused upgrade (a bad credential) is unavailable too', async () => {
    const dead = fakeCore()
    dead.server.stop(true)
    const a = open(dead)
    await until(() => a.ends.length > 0)
    expect(a.ends).toEqual(['unavailable'])
    expect(a.statuses).toEqual(['connecting', 'closed'])

    const refusing = fakeCore()
    refusing.refuse = true
    const b = open(refusing)
    await until(() => b.ends.length > 0)
    expect(b.ends).toEqual(['unavailable'])
  })
})

describe('frames', () => {
  test('a frame is parsed, sanitised and cut to the size and depth', async () => {
    const core = fakeCore()
    const run = open(core, { cols: 20, rows: 3, colorDepth: 4 })
    await until(() => run.statuses.includes('open'))
    frame(
      core.socket() as never,
      0,
      `${ESC}]52;c;QQ==\u0007${ESC}[38;2;255;0;0mred${ESC}[0m\n${ESC}[6n${'x'.repeat(40)}\nthree\nfour`,
    )
    await until(() => run.frames.length === 1)
    const parsed = run.frames[0] as ParsedFrame
    expect(parsed.lines).toHaveLength(3)
    expect(parsed.lines[0]).toEqual([{ text: 'red', fg: 'redBright' }])
    expect(parsed.lines[1]).toEqual([{ text: 'x'.repeat(20) }])
    expect(JSON.stringify(parsed)).not.toContain(ESC)
    run.view.close()
  })

  test('parts reassemble into one frame; a newer frame replaces an unfinished one; a stale one is ignored', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    const ws = core.socket() as ServerWebSocket<undefined>
    frame(ws, 1, 'aa', true)
    frame(ws, 1, 'bb', true)
    frame(ws, 1, 'cc')
    await until(() => run.frames.length === 1)
    expect(run.frames[0]?.lines[0]).toEqual([{ text: 'aabbcc' }])
    // an unfinished frame 2 is replaced by frame 3
    frame(ws, 2, 'lost', true)
    frame(ws, 3, 'three')
    await until(() => run.frames.length === 2)
    expect(run.frames[1]?.lines[0]).toEqual([{ text: 'three' }])
    // a late frame older than the last complete one is dropped
    frame(ws, 2, 'late')
    frame(ws, 4, 'four')
    await until(() => run.frames.length === 3)
    expect(run.frames.map((f) => f.lines[0]?.[0]?.text)).toEqual(['aabbcc', 'three', 'four'])
    run.view.close()
  })

  test('parts that grow past the frame cap end the view with protocol', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    const ws = core.socket() as ServerWebSocket<undefined>
    for (let i = 0; i < 20; i++) frame(ws, 1, 'x'.repeat(16 * 1024), true)
    await until(() => run.ends.length > 0)
    expect(run.ends).toEqual(['protocol'])
  })

  test('garbage from the server ends the view with protocol; binary is ignored', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    core.socket()?.send(new Uint8Array([1, 2, 3]))
    await wait(30)
    expect(run.ends).toEqual([])
    core.socket()?.send('not json')
    await until(() => run.ends.length > 0)
    expect(run.ends).toEqual(['protocol'])
  })
})

describe('input', () => {
  test('keys go out once open; the reserved keys never do; a paste is split', async () => {
    const core = fakeCore()
    const run = open(core)
    run.view.sendKey('too early')
    await until(() => run.statuses.includes('open'))
    run.view.sendKey(`${ESC}[A`)
    run.view.sendKey(ESC)
    run.view.sendKey('\u0007')
    run.view.sendKey('')
    run.view.sendKey('a'.repeat(4096 * 2 + 10))
    await until(() => core.received.filter((m) => m.type === 'key').length === 4)
    const keys = core.received.filter((m) => m.type === 'key').map((m) => String(m.data))
    expect(keys[0]).toBe(`${ESC}[A`)
    expect(keys.slice(1).map((k) => k.length)).toEqual([4096, 4096, 10])
    expect(core.received.some((m) => m.data === ESC || m.data === '\u0007')).toBe(false)
    run.view.close()
  })

  test('a paste never splits a surrogate pair, and is cut at the paste cap', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    run.view.sendKey(`${'a'.repeat(4095)}😀tail`)
    await until(() => core.received.filter((m) => m.type === 'key').length === 2)
    const keys = core.received.filter((m) => m.type === 'key').map((m) => String(m.data))
    expect(keys.join('')).toBe(`${'a'.repeat(4095)}😀tail`)
    expect(keys[0]?.endsWith('a')).toBe(true)
    run.view.sendKey('b'.repeat(200_000))
    await wait(100)
    const total = core.received
      .filter((m) => m.type === 'key')
      .slice(2)
      .reduce((n, m) => n + String(m.data).length, 0)
    expect(total).toBe(64 * 1024)
    run.view.close()
  })

  test('resizes are coalesced into one message with the last size; the frame is cut to it', async () => {
    const core = fakeCore()
    const run = open(core, { resizeMs: 30 })
    await until(() => run.statuses.includes('open'))
    run.view.resize(90, 30)
    run.view.resize(100, 40)
    run.view.resize(120, 50)
    await wait(120)
    expect(core.received.filter((m) => m.type === 'resize')).toEqual([
      { type: 'resize', cols: 120, rows: 50 },
    ])
    frame(core.socket() as never, 0, 'x'.repeat(200))
    await until(() => run.frames.length === 1)
    expect(run.frames[0]?.lines[0]?.[0]?.text).toHaveLength(120)
    run.view.close()
  })
})

describe('ending', () => {
  test('close() says close, the server answers, onEnd is view exactly once and later calls do nothing', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    run.view.close()
    run.view.close()
    await until(() => run.ends.length > 0)
    await wait(30)
    expect(run.ends).toEqual(['view'])
    expect(core.received.filter((m) => m.type === 'close')).toHaveLength(1)
    expect(run.statuses.at(-1)).toBe('closed')
    run.view.sendKey('x')
    run.view.resize(10, 10)
    await wait(50)
    expect(core.received.some((m) => m.type === 'key' || m.type === 'resize')).toBe(false)
  })

  test('close() when the server never answers still ends after closeWaitMs; close() before open drops at once', async () => {
    const core = fakeCore()
    core.onMessage = (ws, m) => {
      if (m.type === 'hello') ws.send(JSON.stringify({ v: 1, type: 'ready', cols: 80, rows: 24 }))
    }
    const run = open(core, { closeWaitMs: 40 })
    await until(() => run.statuses.includes('open'))
    run.view.close()
    expect(run.ends).toEqual([])
    await until(() => run.ends.length > 0)
    expect(run.ends).toEqual(['view'])

    const early = open(fakeCore())
    early.view.close()
    expect(early.ends).toEqual(['view'])
  })

  test('the server reasons come through: idle, revoked, limit, error, refused', async () => {
    for (const reason of ['idle', 'revoked', 'limit', 'error', 'refused'] as const) {
      const core = fakeCore()
      const run = open(core)
      await until(() => run.statuses.includes('open'))
      core.socket()?.send(JSON.stringify({ type: 'closed', reason }))
      await until(() => run.ends.length > 0)
      expect(run.ends).toEqual([reason])
    }
  })

  test('a dropped connection after open is disconnected, and the client does not reconnect', async () => {
    const core = fakeCore()
    const run = open(core)
    await until(() => run.statuses.includes('open'))
    core.socket()?.terminate()
    await until(() => run.ends.length > 0)
    await wait(100)
    expect(run.ends).toEqual(['disconnected'])
    expect(core.received.filter((m) => m.type === 'hello')).toHaveLength(1)
  })

  test('a silent server is disconnected after silentMs; a pong keeps it alive', async () => {
    const alive = fakeCore()
    const a = open(alive, { pingMs: 20, silentMs: 80 })
    await until(() => a.statuses.includes('open'))
    await wait(250)
    expect(a.ends).toEqual([])
    expect(alive.received.filter((m) => m.type === 'ping').length).toBeGreaterThan(3)
    a.view.close()

    const silent = fakeCore()
    silent.onMessage = (ws, m) => {
      if (m.type === 'hello') ws.send(JSON.stringify({ v: 1, type: 'ready', cols: 80, rows: 24 }))
    }
    const b = open(silent, { pingMs: 20, silentMs: 80 })
    await until(() => b.ends.length > 0)
    expect(b.ends).toEqual(['disconnected'])
  })
})

describe('on the Keith client', () => {
  test('viewMenu reads and validates the menu; errors are typed', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const ok = createKeithClient({
      baseUrl: 'http://core.test',
      token: 'keith_s_x',
      fetch: answer(200, {
        items: [{ id: 'notes.browse', plugin: 'notes', label: 'Notes', viewId: 'notes.list' }],
      }),
    })
    expect((await ok.viewMenu()).items[0]?.label).toBe('Notes')
    const denied = createKeithClient({
      baseUrl: 'http://core.test',
      token: 'x',
      fetch: answer(401, {}),
    })
    await expect(denied.viewMenu()).rejects.toMatchObject({ reason: 'unauthorized' })
    const broken = createKeithClient({
      baseUrl: 'http://core.test',
      token: 'x',
      fetch: answer(200, { nope: 1 }),
    })
    await expect(broken.viewMenu()).rejects.toMatchObject({ reason: 'unavailable' })
    const anon = createKeithClient({ baseUrl: 'http://core.test' })
    await expect(anon.viewMenu()).rejects.toBeInstanceOf(ViewMenuError)
    expect(() =>
      anon.openView({
        viewId: 'notes.list',
        cols: 80,
        rows: 24,
        onFrame: () => {},
        onEnd: () => {},
      }),
    ).toThrow(ViewMenuError)
  })

  test('openView uses the client base URL and token', async () => {
    const core = fakeCore()
    const client = createKeithClient({ baseUrl: core.url, token: 'keith_s_tok' })
    const ends: string[] = []
    const view = client.openView({
      viewId: 'notes.list',
      cols: 80,
      rows: 24,
      onFrame: () => {},
      onEnd: (r) => ends.push(r),
    })
    await until(() => core.received.length > 0)
    expect(core.headers[0]?.get('authorization')).toBe('Bearer keith_s_tok')
    view.close()
    await until(() => ends.length > 0)
  })

  test('with a socketPath it connects over the Unix socket and sends no credential', async () => {
    const path = `/tmp/keith-view-${crypto.randomUUID().slice(0, 8)}.sock`
    const seen: Array<string | null> = []
    const server = Bun.serve<undefined>({
      unix: path,
      fetch(request, srv) {
        seen.push(request.headers.get('authorization'))
        return srv.upgrade(request, { data: undefined })
          ? undefined
          : new Response('no', { status: 426 })
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw)) as { type: string; cols?: number; rows?: number }
          if (m.type === 'hello')
            ws.send(JSON.stringify({ v: 1, type: 'ready', cols: m.cols, rows: m.rows }))
          else if (m.type === 'close') ws.send(JSON.stringify({ type: 'closed', reason: 'view' }))
        },
      },
    })
    try {
      const client = createKeithClient({ baseUrl: 'http://localhost', socketPath: path })
      const statuses: string[] = []
      const ends: string[] = []
      const view = client.openView({
        viewId: 'notes.list',
        cols: 80,
        rows: 24,
        onFrame: () => {},
        onStatus: (s) => statuses.push(s),
        onEnd: (r) => ends.push(r),
      })
      await until(() => statuses.includes('open'))
      expect(seen).toEqual([null])
      view.close()
      await until(() => ends.length > 0)
    } finally {
      server.stop(true)
    }
  })
})
