/** Server limits (pre-auth exhaustion): body cap on the open join route, bounded idle timeout. */
import { afterAll, describe, expect, test } from 'bun:test'
import { boot, cleanup, newDir } from './testing/core-harness.ts'

afterAll(cleanup)

describe('server limits', () => {
  test('a 2 MB POST to /nodes/join is refused before it is read (413)', async () => {
    const r = await boot(newDir(), [])
    const res = await fetch(`${r.server.url.origin}/nodes/join`, {
      method: 'POST',
      body: 'x'.repeat(2 * 1024 * 1024),
    }).catch(() => undefined)
    // Bun's maxRequestBodySize answers 413 itself; a dropped connection is also a refusal
    expect(res === undefined || res.status === 413).toBe(true)
  })

  test('a 100 KB POST to /nodes/join is 413 from the route (under Bun’s cap)', async () => {
    const r = await boot(newDir(), [])
    const res = await fetch(`${r.server.url.origin}/nodes/join`, {
      method: 'POST',
      body: JSON.stringify({ code: 'x', pad: 'x'.repeat(100_000) }),
    })
    expect(res.status).toBe(413)
  })

  test('an authorized stream outlives the idle timeout', async () => {
    const r = await boot(newDir(), [])
    const short = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch: r.core.fetch,
      websocket: r.core.websocket,
    })
    try {
      const res = await fetch(`${short.url.origin}/activity/stream`, {
        headers: { authorization: `Bearer ${r.token}` },
      })
      expect(res.status).toBe(200)
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const closed = await Promise.race([
        (async () => {
          for (;;) if ((await reader.read()).done) return true
        })(),
        Bun.sleep(3_000).then(() => false),
      ])
      expect(closed).toBe(false)
      await reader.cancel()
    } finally {
      await short.stop(true)
    }
  })

  test('a connection that sends nothing is closed by the idle timeout', async () => {
    const r = await boot(newDir(), [])
    const short = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch: r.core.fetch,
      websocket: r.core.websocket,
    })
    try {
      const closed = Promise.withResolvers<void>()
      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port: short.port as number,
        socket: { data() {}, close: () => closed.resolve(), error: () => closed.resolve() },
      })
      socket.write('POST /nodes/join HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n')
      const winner = await Promise.race([
        closed.promise.then(() => 'closed'),
        Bun.sleep(4_000).then(() => 'open'),
      ])
      socket.end()
      expect(winner).toBe('closed')
    } finally {
      await short.stop(true)
    }
  })
})
