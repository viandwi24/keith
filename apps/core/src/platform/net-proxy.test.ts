import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetProxy, freshFor, type NetFetch } from './net-proxy.ts'

// The core's outbound fetch for public files (docs/specs/net-proxy.md): User-Agent, no redirect, per-host limit, disk cache, stale
// copy on failure, type and size checks.

const PNG = ['image/png']
const dirs: string[] = []
const cacheDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'keith-net-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const png = (headers: Record<string, string> = {}) =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png', ...headers },
  })

describe('net proxy', () => {
  test('an untyped answer is kept only when sniff names an accepted type from its bytes', async () => {
    const net = createNetProxy({
      cacheDir: cacheDir(),
      userAgent: 'keith/test',
      fetch: async (url) =>
        new Response(
          url.endsWith('/img')
            ? new Uint8Array([137, 80, 78, 71])
            : new TextEncoder().encode('<p>'),
          { headers: { 'content-type': 'application/octet-stream' } },
        ),
    })
    const sniff = (b: Uint8Array) => (b[0] === 137 ? 'image/png' : undefined)
    expect(await net.get('https://cam.example/img', PNG, { sniff })).toMatchObject({
      ok: true,
      type: 'image/png',
    })
    expect(await net.get('https://cam.example/page', PNG, { sniff })).toMatchObject({
      ok: false,
      status: 415,
    })
    // without a sniffer an untyped answer is refused as before
    expect(await net.get('https://cam.example/other/img', PNG)).toMatchObject({
      ok: false,
      status: 415,
    })
  })

  test('sends Keith’s User-Agent, never follows a redirect, caches for max-age', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetch: NetFetch = async (url, init) => {
      seen.push({ url, init })
      return png({ 'cache-control': 'max-age=7200' })
    }
    let clock = 1_000
    const net = createNetProxy({
      cacheDir: cacheDir(),
      userAgent: 'keith/test',
      fetch,
      now: () => clock,
    })
    const first = await net.get('https://tile.example/1/2/3.png', PNG)
    expect(first).toMatchObject({ ok: true, type: 'image/png', from: 'upstream' })
    expect(seen[0]?.init.redirect).toBe('error')
    expect(new Headers(seen[0]?.init.headers).get('user-agent')).toBe('keith/test')
    expect(await net.get('https://tile.example/1/2/3.png', PNG)).toMatchObject({ from: 'cache' })
    expect(seen).toHaveLength(1)
    clock += 7_200_001
    expect(await net.get('https://tile.example/1/2/3.png', PNG)).toMatchObject({ from: 'upstream' })
    expect(seen).toHaveLength(2)
  })

  test('a live resource is kept only liveMs, below the one-hour floor', async () => {
    let calls = 0
    const fetch: NetFetch = async () => {
      calls++
      return png({ 'cache-control': 'max-age=86400' })
    }
    let clock = 0
    const net = createNetProxy({ cacheDir: cacheDir(), userAgent: 'k', fetch, now: () => clock })
    await net.get('https://cam.example/1.jpg', PNG, { liveMs: 20_000 })
    clock += 19_000
    expect(await net.get('https://cam.example/1.jpg', PNG, { liveMs: 20_000 })).toMatchObject({
      from: 'cache',
    })
    clock += 2_000
    expect(await net.get('https://cam.example/1.jpg', PNG, { liveMs: 20_000 })).toMatchObject({
      from: 'upstream',
    })
    expect(calls).toBe(2)
  })

  test('a stale copy covers an upstream failure; without one the failure is told', async () => {
    let fail = false
    let clock = 0
    const fetch: NetFetch = async () => {
      if (fail) throw new Error('down')
      return png({ 'cache-control': 'max-age=3600' })
    }
    const net = createNetProxy({ cacheDir: cacheDir(), userAgent: 'k', fetch, now: () => clock })
    await net.get('https://tile.example/a.png', PNG)
    fail = true
    clock += 10 * 3_600_000
    expect(await net.get('https://tile.example/a.png', PNG)).toMatchObject({
      ok: true,
      from: 'stale',
    })
    expect(await net.get('https://tile.example/b.png', PNG)).toEqual({
      ok: false,
      status: 502,
      reason: 'upstream unreachable',
    })
  })

  test('only https, only the accepted type, only up to maxBytes; 404 passes through', async () => {
    const net = createNetProxy({
      cacheDir: cacheDir(),
      userAgent: 'k',
      maxBytes: 3,
      fetch: async (url) => {
        if (url.endsWith('/html'))
          return new Response('<p>', { headers: { 'content-type': 'text/html' } })
        if (url.endsWith('/gone')) return new Response('', { status: 404 })
        return png()
      },
    })
    expect(await net.get('http://tile.example/a.png', PNG)).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(await net.get('https://u:p@tile.example/a.png', PNG)).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(await net.get('https://tile.example/html', PNG)).toMatchObject({
      ok: false,
      status: 415,
    })
    expect(await net.get('https://tile.example/gone', PNG)).toMatchObject({
      ok: false,
      status: 404,
    })
    expect(await net.get('https://tile.example/big.png', PNG)).toMatchObject({
      ok: false,
      status: 413,
    })
  })

  test('at most perHost requests reach one host at once; past the queue it is 503', async () => {
    let running = 0
    let peak = 0
    const release: (() => void)[] = []
    const fetch: NetFetch = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((go) => release.push(go))
      running--
      return png({ 'cache-control': 'no-store' })
    }
    const net = createNetProxy({
      cacheDir: cacheDir(),
      userAgent: 'k',
      fetch,
      perHost: 2,
      queue: 1,
    })
    const calls = [1, 2].map((n) => net.get(`https://tile.example/${n}.png`, PNG))
    while (release.length < 2) await Bun.sleep(1)
    calls.push(net.get('https://tile.example/3.png', PNG))
    await Bun.sleep(5)
    // two in flight, one waiting: the queue (1) is full
    expect(await net.get('https://tile.example/4.png', PNG)).toMatchObject({
      ok: false,
      status: 503,
    })
    expect(peak).toBe(2)
    while (release.length > 0 || running > 0) {
      release.shift()?.()
      await Bun.sleep(1)
    }
    expect((await Promise.all(calls)).every((r) => r.ok)).toBe(true)
    expect(peak).toBe(2)
  })

  test('freshFor reads max-age, clamps it and honours no-store', () => {
    expect(freshFor(null, 5)).toBe(5)
    expect(freshFor('public, max-age=10', 5)).toBe(3_600_000)
    expect(freshFor('max-age=86400', 5)).toBe(86_400_000)
    expect(freshFor('max-age=999999999', 5)).toBe(30 * 86_400_000)
    expect(freshFor('no-store', 5)).toBe(0)
  })
})
