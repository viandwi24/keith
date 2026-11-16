import { describe, expect, test } from 'bun:test'
import type { NetProxy, NetResult } from '../../platform/net-proxy.ts'
import { createPluginNet, isPluginNetPath, NET_IMAGE_TYPES, sniffImage } from './plugin-net.ts'

// The plugin net route (docs/specs/thalamus.md, "Plugin net route"): only hosts a plugin's window apps declared, only images,
// relayed through the core's net proxy.

const contributions = () => [
  {
    point: 'web.window',
    contributor: 'maps',
    id: 'map',
    entry: {
      network: ['https://tile.openstreetmap.org', 'https://cams.example'],
      live: ['https://cams.example', 'https://undeclared.example'],
    },
  },
  {
    point: 'web.window',
    contributor: 'other',
    id: 'x',
    entry: { network: ['https://evil.example'] },
  },
]

const setup = (
  answer: NetResult = {
    ok: true,
    body: new Uint8Array([1, 2]),
    type: 'image/png',
    from: 'upstream',
  },
) => {
  const asked: { url: string; accept: readonly string[]; liveMs?: number }[] = []
  const proxy: NetProxy = {
    get: async (url, accept, options) => {
      asked.push(
        options?.liveMs === undefined ? { url, accept } : { url, accept, liveMs: options.liveMs },
      )
      return answer
    },
  }
  return { asked, net: createPluginNet({ proxy, contributions }) }
}

const get = (net: ReturnType<typeof setup>['net'], path: string, method = 'GET') =>
  net.serve(new Request(`http://keith.test${path}`, { method }))

describe('plugin net route', () => {
  test('a declared host is fetched over https, images only, with strict headers', async () => {
    const { net, asked } = setup()
    const res = await get(net, '/plugins/maps/net/tile.openstreetmap.org/13/6661/4261.png?x=1')
    expect(res.status).toBe(200)
    expect(asked).toEqual([
      { url: 'https://tile.openstreetmap.org/13/6661/4261.png', accept: NET_IMAGE_TYPES },
    ])
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('x-keith-cache')).toBe('upstream')
    expect(NET_IMAGE_TYPES).not.toContain('image/svg+xml')
  })

  test('a live host is kept 20 s by the core and not cached by the browser; live alone does not open a host', async () => {
    const { net, asked } = setup()
    const res = await get(net, '/plugins/maps/net/cams.example/c/1.jpg?t=5')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(asked).toEqual([
      { url: 'https://cams.example/c/1.jpg', accept: NET_IMAGE_TYPES, liveMs: 20_000 },
    ])
    expect((await get(net, '/plugins/maps/net/undeclared.example/c.jpg')).status).toBe(404)
    const tile = await get(net, '/plugins/maps/net/tile.openstreetmap.org/1/0/0.png')
    expect(tile.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  test('a host another plugin declared, an unknown plugin or a dot segment is 404 and never fetched', async () => {
    const { net, asked } = setup()
    expect((await get(net, '/plugins/maps/net/evil.example/a.png')).status).toBe(404)
    expect((await get(net, '/plugins/nope/net/tile.openstreetmap.org/a.png')).status).toBe(404)
    expect((await get(net, '/plugins/maps/net/tile.openstreetmap.org/../x.png')).status).toBe(404)
    expect((await get(net, '/plugins/maps/net/tile.openstreetmap.org/a//b.png')).status).toBe(404)
    expect(asked).toHaveLength(0)
  })

  test('only GET and HEAD; a proxy refusal keeps its status', async () => {
    const { net } = setup({ ok: false, status: 503, reason: 'too many requests to this host' })
    expect((await get(net, '/plugins/maps/net/tile.openstreetmap.org/a.png', 'POST')).status).toBe(
      405,
    )
    const res = await get(net, '/plugins/maps/net/tile.openstreetmap.org/a.png')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('too many requests to this host\n')
  })

  test('isPluginNetPath matches the route only', () => {
    expect(isPluginNetPath('/plugins/maps/net/tile.openstreetmap.org/1/2/3.png')).toBe(true)
    expect(isPluginNetPath('/plugins/maps/web/map.html')).toBe(false)
    expect(isPluginNetPath('/plugins/maps/search')).toBe(false)
  })
})

describe('sniffImage', () => {
  test('names an image from its first bytes, nothing else', () => {
    const b = (...x: number[]) => new Uint8Array(x)
    expect(sniffImage(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png')
    expect(sniffImage(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImage(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(sniffImage(b(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp',
    )
    expect(sniffImage(new TextEncoder().encode('<svg onload=x>'))).toBeUndefined()
    expect(sniffImage(new TextEncoder().encode('<html>'))).toBeUndefined()
  })
})
