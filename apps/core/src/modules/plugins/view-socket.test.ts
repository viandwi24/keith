import { describe, expect, test } from 'bun:test'
import { VIEW_LIMITS } from '@keith/contracts'
import type { OpenViewRequest, ViewHandle, ViewHost, ViewListeners } from '@keith/host/views'
import { createViewAudit } from './view-audit.ts'
import { chunkFrame, createViewGateway, type ViewSocketData } from './view-socket.ts'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A fake view host: records what the gateway asks and lets a test push frames and close the view. */
function fakeViews(result: 'ok' | 'limit' = 'ok') {
  const keys: string[] = []
  const sizes: Array<[number, number]> = []
  const closes: string[] = []
  let listeners: ViewListeners | undefined
  let request: OpenViewRequest | undefined
  let release: (() => void) | undefined
  const gate = { hold: false }
  const view: ViewHandle = {
    id: 'v1',
    viewId: 'pp.v',
    principalId: 'ana',
    closed: false,
    key: (d) => void keys.push(d),
    resize: (c, r) => void sizes.push([c, r]),
    close(reason = 'view') {
      closes.push(reason)
      listeners?.closed(reason)
    },
  }
  const host: ViewHost = {
    async open(req, l) {
      request = req
      listeners = l
      if (gate.hold) await new Promise<void>((r) => (release = r))
      return result === 'ok' ? { ok: true, view } : { ok: false, reason: 'limit' }
    },
    closeFor: () => 0,
    closeAll: () => {},
    snapshot: () => [],
  }
  return {
    host,
    keys,
    sizes,
    closes,
    gate,
    release: () => release?.(),
    emit: (seq: number, text: string) => listeners?.frame({ seq, text }),
    request: () => request,
  }
}

function setup(
  options: Partial<Parameters<typeof createViewGateway>[0]> = {},
  views = fakeViews(),
  allowed = { value: true },
) {
  const gateway = createViewGateway({
    views: views.host,
    access: { find: async () => (allowed.value ? ({} as never) : undefined) },
    authenticate: async () => undefined,
    ...options,
  })
  const sent: Array<Record<string, unknown>> = []
  const closed: Array<{ code?: number | undefined; reason?: string | undefined }> = []
  const buffered = { value: 0 }
  const data: ViewSocketData = {
    kind: 'view',
    principalId: 'ana',
    method: 'password',
    stillAllowed: async () => allowed.value,
    via: 'tcp',
    state: {
      phase: 'hello',
      ready: false,
      lastSeen: Date.now(),
      windowStart: 0,
      windowCount: 0,
      closeRequested: false,
    },
  }
  const ws = {
    data,
    send: (text: string) => {
      sent.push(JSON.parse(text))
      return text.length
    },
    close: (code?: number, reason?: string) => void closed.push({ code, reason }),
    getBufferedAmount: () => buffered.value,
  }
  const handler = gateway.websocket as unknown as {
    open(ws: unknown): void
    message(ws: unknown, raw: string | Buffer): void
    close(ws: unknown): void
    drain(ws: unknown): void
  }
  handler.open(ws)
  const say = (m: unknown) => handler.message(ws, typeof m === 'string' ? m : JSON.stringify(m))
  return { gateway, handler, ws, sent, closed, buffered, say, views }
}
const hello = { v: 1, type: 'hello', viewId: 'pp.v', cols: 80, rows: 24, colorDepth: 24 }

describe('chunkFrame', () => {
  test('short text is one part; long text reassembles exactly and never splits a surrogate pair', () => {
    expect(chunkFrame('abc', 10)).toEqual(['abc'])
    const text = `${'a'.repeat(9)}😀${'b'.repeat(30)}😀😀`
    for (const size of [10, 11, 7, 3]) {
      const parts = chunkFrame(text, size)
      expect(parts.join('')).toBe(text)
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(size)
        const first = part.charCodeAt(0)
        const last = part.charCodeAt(part.length - 1)
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false) // starts with a low half
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false) // ends with a high half
      }
    }
  })
})

describe('the view socket handler', () => {
  test('no hello in time: closed refused', async () => {
    const t = setup({ helloTimeoutMs: 30 })
    await wait(80)
    expect(t.sent).toEqual([{ type: 'closed', reason: 'refused' }])
    expect(t.closed).toEqual([{ code: 1000, reason: 'refused' }])
    t.gateway.close()
  })

  test('hello opens the view with the socket facts and answers ready before any frame', async () => {
    const t = setup()
    t.say(hello)
    await wait(10)
    expect(t.views.request()).toMatchObject({
      viewer: { principalId: 'ana', method: 'password' },
      viewId: 'pp.v',
      cols: 80,
      rows: 24,
    })
    t.views.emit(0, 'first frame')
    await wait(5)
    expect(t.sent.map((m) => m.type)).toEqual(['ready', 'frame'])
    t.gateway.close()
  })

  test('a frame emitted while the view opens waits for ready', async () => {
    const views = fakeViews()
    views.gate.hold = true
    const t = setup({}, views)
    t.say(hello)
    await wait(5)
    views.emit(0, 'early')
    expect(t.sent).toEqual([])
    views.release()
    await wait(10)
    expect(t.sent.map((m) => m.type)).toEqual(['ready', 'frame'])
    t.gateway.close()
  })

  test('limit and a close during opening', async () => {
    const t = setup({}, fakeViews('limit'))
    t.say(hello)
    await wait(10)
    expect(t.sent).toEqual([{ type: 'closed', reason: 'limit' }])

    const views = fakeViews()
    views.gate.hold = true
    const u = setup({}, views)
    u.say(hello)
    await wait(5)
    u.say({ type: 'close' })
    views.release()
    await wait(10)
    expect(u.sent.at(-1)).toEqual({ type: 'closed', reason: 'view' })
    expect(views.closes).toEqual(['view'])
    t.gateway.close()
    u.gateway.close()
  })

  test('long frames are chunked; parts share the seq and all but the last carry more', async () => {
    const t = setup()
    t.say(hello)
    await wait(10)
    t.views.emit(7, 'x'.repeat(VIEW_LIMITS.frameChunkChars * 2 + 5))
    const frames = t.sent.filter((m) => m.type === 'frame')
    expect(frames.map((f) => f.more)).toEqual([true, true, undefined])
    expect(new Set(frames.map((f) => f.seq))).toEqual(new Set([7]))
    t.gateway.close()
  })

  test('backpressure: while the socket is backed up only the newest frame is kept, and drain sends it', async () => {
    const t = setup({ bufferHighBytes: 1000 })
    t.say(hello)
    await wait(10)
    t.buffered.value = 5000
    t.views.emit(1, 'one')
    t.views.emit(2, 'two')
    t.views.emit(3, 'three')
    expect(t.sent.filter((m) => m.type === 'frame')).toEqual([])
    t.buffered.value = 0
    t.handler.drain(t.ws)
    expect(t.sent.filter((m) => m.type === 'frame')).toEqual([
      { type: 'frame', seq: 3, text: 'three' },
    ])
    t.gateway.close()
  })

  test('a client that stays behind too long is closed', async () => {
    const t = setup({ bufferHighBytes: 10, lagMs: 40, sweepMs: 20 })
    t.say(hello)
    await wait(10)
    t.buffered.value = 999
    t.views.emit(1, 'stuck')
    await wait(150)
    expect(t.sent.at(-1)).toEqual({ type: 'closed', reason: 'error' })
    t.gateway.close()
  })

  test('keys, resize and ping reach the view or answer; binary and unknown messages do not', async () => {
    const t = setup()
    t.say(hello)
    await wait(10)
    t.say({ type: 'key', data: 'abc' })
    t.say({ type: 'resize', cols: 100, rows: 30 })
    t.say({ type: 'ping' })
    t.handler.message(t.ws, Buffer.from('binary'))
    expect(t.views.keys).toEqual(['abc'])
    expect(t.views.sizes).toEqual([[100, 30]])
    expect(t.sent.at(-1)).toEqual({ type: 'pong' })
    t.say({ type: 'nope' })
    expect(t.sent.at(-1)).toEqual({ type: 'closed', reason: 'error' })
    t.gateway.close()
  })

  test('a flood of messages closes the socket', async () => {
    const t = setup({ messagesPerSecond: 20 })
    t.say(hello)
    await wait(10)
    for (let i = 0; i < 30; i++) t.say({ type: 'key', data: 'a' })
    expect(t.sent.at(-1)).toEqual({ type: 'closed', reason: 'error' })
    expect(t.views.keys.length).toBeLessThanOrEqual(20)
    t.gateway.close()
  })

  test('a viewer who is no longer allowed gets revoked; so does one who loses the view', async () => {
    const allowed = { value: true }
    const t = setup({ sweepMs: 20 }, fakeViews(), allowed)
    t.say(hello)
    await wait(40)
    expect(t.sent.some((m) => m.type === 'closed')).toBe(false)
    allowed.value = false
    await wait(80)
    expect(t.sent.at(-1)).toEqual({ type: 'closed', reason: 'revoked' })
    expect(t.views.closes).toEqual(['revoked'])
    t.gateway.close()
  })

  test('a silent peer is closed; the socket closing tears the view down and stops the sweeper', async () => {
    const t = setup({ silentMs: 40, sweepMs: 20 })
    t.say(hello)
    await wait(120)
    expect(t.sent.at(-1)).toEqual({ type: 'closed', reason: 'error' })

    const u = setup()
    u.say(hello)
    await wait(10)
    expect(u.gateway.connections()).toBe(1)
    u.handler.close(u.ws)
    expect(u.views.closes).toEqual(['view'])
    expect(u.gateway.connections()).toBe(0)
    t.gateway.close()
  })
})

describe('audit and the open rate', () => {
  test('an open and a close are audited with ids and the reason only; a frame and a key never are', async () => {
    const rows: Array<{ kind: string; detail: Record<string, unknown> }> = []
    const audit = createViewAudit({ record: (e) => rows.push({ kind: e.kind, detail: e.detail }) })
    const t = setup({ audit })
    t.say(hello)
    await wait(10)
    t.views.emit(0, 'SECRET FRAME TEXT')
    t.say({ type: 'key', data: 'secret typed text' })
    await wait(5)
    t.say({ type: 'close' })
    await wait(10)
    expect(rows.map((r) => r.kind)).toEqual(['plugin.view.open', 'plugin.view.close'])
    expect(rows[0]?.detail).toEqual({ viewId: 'pp.v' })
    expect(rows[1]?.detail).toMatchObject({ viewId: 'pp.v', reason: 'view' })
    expect(JSON.stringify(rows)).not.toContain('SECRET')
    expect(JSON.stringify(rows)).not.toContain('secret typed')
    t.gateway.close()
  })

  test('a dropped socket is audited as disconnected', async () => {
    const rows: string[] = []
    const audit = createViewAudit({
      record: (e) => rows.push(`${e.kind} ${JSON.stringify(e.detail)}`),
    })
    const t = setup({ audit })
    t.say(hello)
    await wait(10)
    t.handler.close(t.ws)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('"reason":"disconnected"')
    t.gateway.close()
  })
})
