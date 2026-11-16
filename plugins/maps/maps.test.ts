import { describe, expect, test } from 'bun:test'
import { WEB_WINDOW_POINT, WindowAppContributionSchema } from '@keith/contracts'
import { memoryHost } from '@keith/host/testing'
import maps, { createMapsPlugin, mapWindow } from './plugin.ts'
import { type FetchLike, USER_AGENT } from './upstream.ts'

const SURABAYA = {
  place_id: 1,
  lat: '-7.2459717',
  lon: '112.7378266',
  category: 'boundary',
  type: 'administrative',
  addresstype: 'city',
  name: 'Surabaya',
  display_name: 'Surabaya, East Java, Java, Indonesia',
  boundingbox: ['-7.3517', '-7.1876', '112.5928', '112.8466'],
}

function setup(fetchImpl: FetchLike) {
  const host = memoryHost({ plugins: [createMapsPlugin({ fetch: fetchImpl, minGapMs: 0 })] })
  host.add('mia')
  return host
}
const search = (host: ReturnType<typeof setup>, input: unknown) =>
  host.call('maps', 'search', input, 'mia') as Promise<{ results: Record<string, unknown>[] }>
const fails = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    const e = error as { code?: string; message: string }
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a refusal')
}

describe('maps: search', () => {
  test('asks Nominatim with the generic User-Agent and maps its answer', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const host = setup(async (url, init) => {
      seen.push({ url, init })
      return Response.json([SURABAYA, { lat: 'x', lon: '1', display_name: 'broken' }])
    })
    const out = await search(host, { query: 'Surabaya', limit: 3 })
    expect(out.results).toEqual([
      {
        name: 'Surabaya, East Java, Java, Indonesia',
        lat: -7.2459717,
        lon: 112.7378266,
        bbox: [-7.3517, -7.1876, 112.5928, 112.8466],
        kind: 'city',
      },
    ])
    const url = new URL(seen[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('q')).toBe('Surabaya')
    expect(url.searchParams.get('limit')).toBe('3')
    const headers = new Headers(seen[0]?.init?.headers)
    expect(headers.get('user-agent')).toBe(USER_AGENT)
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('falls back to Photon when Nominatim fails or finds nothing', async () => {
    const photon = {
      features: [
        {
          geometry: { coordinates: [112.7378, -7.2459] },
          properties: {
            name: 'Tunjungan Plaza',
            street: 'Jalan Basuki Rahmat',
            city: 'Surabaya',
            country: 'Indonesia',
            osm_value: 'mall',
            extent: [112.73, -7.24, 112.74, -7.25],
          },
        },
      ],
    }
    const hosts: string[] = []
    const host = setup(async (url) => {
      hosts.push(new URL(url).host)
      if (url.includes('nominatim')) return new Response('busy', { status: 503 })
      return Response.json(photon)
    })
    const out = await host.call('maps', 'search', { query: 'tunjungan plaz' }, 'mia')
    expect(out).toEqual({
      source: 'photon',
      results: [
        {
          name: 'Tunjungan Plaza, Jalan Basuki Rahmat, Surabaya, Indonesia',
          lat: -7.2459,
          lon: 112.7378,
          bbox: [-7.25, -7.24, 112.73, 112.74],
          kind: 'mall',
        },
      ],
    })
    expect(hosts).toEqual(['nominatim.openstreetmap.org', 'photon.komoot.io'])
    const empty = setup(async (url) =>
      url.includes('nominatim') ? Response.json([]) : Response.json(photon),
    )
    expect(await empty.call('maps', 'search', { query: 'x' }, 'mia')).toMatchObject({
      source: 'photon',
    })
  })

  test('clips names to 200 characters and keeps at most `limit` results', async () => {
    const long = { ...SURABAYA, display_name: 'x'.repeat(500) }
    const host = setup(async () => Response.json([long, long, long]))
    const out = await search(host, { query: 'x', limit: 2 })
    expect(out.results).toHaveLength(2)
    expect(String(out.results[0]?.name)).toHaveLength(200)
  })

  test('an HTTP error, a timeout and an unreadable answer are clear refusals', async () => {
    const http = setup(async () => new Response('busy', { status: 503 }))
    expect(await fails(search(http, { query: 'Surabaya' }))).toEqual({
      code: 'CONFLICT',
      message: 'the map search failed (HTTP 503)',
    })
    const slow = setup(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    expect((await fails(search(slow, { query: 'Surabaya' }))).message).toContain('in time')
    const junk = setup(async () => new Response('<html>', { status: 200 }))
    expect((await fails(search(junk, { query: 'Surabaya' }))).message).toContain('unreadable')
  })

  test('the input is validated: an empty query or a limit above 5 is refused', async () => {
    const host = setup(async () => Response.json([]))
    expect((await fails(search(host, { query: '' }))).code).toBe('INVALID_INPUT')
    expect((await fails(search(host, { query: 'a', limit: 9 }))).code).toBe('INVALID_INPUT')
  })

  test('the operation reads outside data, is a read, and asks for a signed-in actor', () => {
    const op = maps.operation('search')
    expect(op?.toolName).toBe('maps_search')
    expect(op?.source).toBe('outside')
    expect(op?.risk).toBe('read')
    expect(op?.permission.capability).toBe('authenticated')
  })
})

describe('maps: window app', () => {
  test('the map contribution parses against the web.window schema', () => {
    const contributions = maps.manifest.contributes?.[WEB_WINDOW_POINT] ?? []
    expect(contributions).toHaveLength(1)
    const parsed = WindowAppContributionSchema.parse(contributions[0])
    expect(parsed.entry).toEqual({ path: './web/map.html' })
    expect(parsed.network).toContain('https://tile.openstreetmap.org')
    expect(parsed.network).toContain('https://tdcctv.data.one.gov.hk')
    expect(parsed.network.length).toBeLessThanOrEqual(32)
    expect(parsed.live).toContain('https://tdcctv.data.one.gov.hk')
    for (const origin of parsed.live) expect(parsed.network).toContain(origin)
    expect(parsed.gpu).toBe(true)
    expect(parsed.media).toBe(true)
    expect(parsed.calls).toEqual(['search', 'route', 'layers'])
    expect(mapWindow.params.parse({ lat: -7.25, lon: 112.74 })).toEqual({
      lat: -7.25,
      lon: 112.74,
      zoom: 13,
    })
    expect(mapWindow.params.safeParse({ lat: 91, lon: 0 }).success).toBe(false)
    const routed = {
      lat: -7.25,
      lon: 112.74,
      style: 'topo',
      route: {
        from: { lat: -7.2, lon: 112.7, label: 'A' },
        to: { lat: -7.3, lon: 112.8 },
        mode: 'motorcycle',
      },
      places: Array.from({ length: 20 }, (_, i) => ({ lat: i, lon: i, label: 'x'.repeat(40) })),
      view: '2d',
      layers: [
        'flights',
        'cameras',
        'quakes',
        'weather',
        'radio',
        'satellites',
        'transit',
        'events',
      ],
      marks: Array.from({ length: 12 }, (_, i) => ({
        kind: i % 2 === 0 ? 'line' : 'pin',
        points:
          i % 2 === 0
            ? [
                [-7.123456, 112.123456],
                [-7.223456, 112.223456],
                [-7.323456, 112.323456],
                [-7.423456, 112.423456],
                [-7.523456, 112.523456],
              ]
            : [[-7.123456, 112.123456]],
        label: 'y'.repeat(40),
        color: 'amber',
      })),
    }
    expect(mapWindow.params.safeParse(routed).success).toBe(true)
    // the biggest params still fit the workspace limit (4 KB)
    expect(JSON.stringify(mapWindow.params.parse(routed)).length).toBeLessThan(4096)
    expect(mapWindow.params.safeParse({ ...routed, style: 'neon' }).success).toBe(false)
    const tooMany = { kind: 'line', points: Array.from({ length: 41 }, (_, i) => [0, i / 10]) }
    expect(mapWindow.params.safeParse({ lat: 0, lon: 0, marks: [tooMany] }).success).toBe(false)
  })

  test('the manifest names its web folder, and the entry page exists in it', async () => {
    const dir = maps.manifest.web?.dir ?? ''
    expect(dir.endsWith('/web')).toBe(true)
    const html = await Bun.file(`${dir}/map.html`).text()
    // no inline script or style: the bundle CSP is script-src 'self'; style-src 'self'
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/)
    expect(html).not.toMatch(/<style|\sstyle=/)
    expect(html).toContain('OpenStreetMap')
  })
})

describe('maps: data layers', () => {
  test('layers answers each layer, a failing source as an error of its own', async () => {
    const host = setup(async (url) => {
      if (url.includes('2.5_day.geojson'))
        return Response.json({
          features: [
            {
              id: 'q1',
              properties: { mag: 4.2, place: 'Java', time: 1 },
              geometry: { coordinates: [112, -8, 10] },
            },
          ],
        })
      return new Response('down', { status: 503 })
    })
    const out = (await host.call(
      'maps',
      'layers',
      { ids: ['quakes', 'flights', 'cameras'], bbox: [-8, -7, 112, 113], zoom: 6 },
      'mia',
    )) as { layers: { id: string; features: unknown[]; error?: string; note?: string }[] }
    const byId = Object.fromEntries(out.layers.map((l) => [l.id, l]))
    expect(byId.quakes?.features).toHaveLength(1)
    expect(byId.quakes?.note).toBe('BMKG did not answer')
    expect(byId.flights?.error).toContain('HTTP 503')
    expect(byId.cameras?.note).toBe('zoom in to 9 to see it')
    const err = await fails(
      host.call('maps', 'layers', { ids: ['nope'], bbox: [0, 1, 0, 1], zoom: 3 }, 'mia'),
    )
    expect(err.code).toBe('INVALID_INPUT')
  })

  test('explore reads a layer around a position, nearest first, and the window op stays off the model', async () => {
    const host = setup(async (url) => {
      if (url.includes('radio-browser'))
        return Response.json([
          {
            stationuuid: 'far',
            name: 'Far FM',
            url_resolved: 'https://s.example/far',
            geo_lat: -7.45,
            geo_long: 112.74,
          },
          {
            stationuuid: 'near',
            name: 'Near FM',
            url_resolved: 'https://s.example/near',
            geo_lat: -7.26,
            geo_long: 112.74,
          },
          {
            stationuuid: 'out',
            name: 'Out FM',
            url_resolved: 'https://s.example/out',
            geo_lat: 0,
            geo_long: 0,
          },
        ])
      return new Response('down', { status: 503 })
    })
    const out = (await host.call(
      'maps',
      'explore',
      { layer: 'radio', near: { lat: -7.25, lon: 112.74 }, radiusKm: 30 },
      'mia',
    )) as {
      items: { label: string; playable?: boolean; distanceKm?: number }[]
      total: number
      zoom: number
    }
    expect(out.items.map((i) => i.label)).toEqual(['Near FM', 'Far FM'])
    expect(out.items[0]?.playable).toBe(true)
    expect(out.zoom).toBeGreaterThan(8)
    const layers = maps.operation('layers')
    expect(layers?.expose.ai).toBe(false)
    expect(maps.operation('explore')?.expose.ai).toBe(true)
  })
})
