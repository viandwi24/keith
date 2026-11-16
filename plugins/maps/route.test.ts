import { describe, expect, test } from 'bun:test'
import { memoryHost } from '@keith/host/testing'
import { bboxOf, decodePolyline, haversine, type LatLon, simplify } from './geo.ts'
import { overpassQuery, tagFilter } from './nearby.ts'
import maps, { createMapsPlugin } from './plugin.ts'
import { formatDistance, formatDuration, osrmStepText, trimSteps } from './route.ts'
import { createUpstream, type FetchLike } from './upstream.ts'

// maps_route (OSRM, then Valhalla), maps_nearby (Overpass, then a mirror), the request spacing and the geometry helpers.

const A = { lat: -7.2575, lon: 112.7521 }
const B = { lat: -7.2905, lon: 112.7398 }

const osrmOk = {
  code: 'Ok',
  routes: [
    {
      distance: 5234.5,
      duration: 812.2,
      geometry: {
        coordinates: [
          [112.7521, -7.2575],
          [112.7455, -7.27],
          [112.7398, -7.2905],
        ],
      },
      legs: [
        {
          steps: [
            {
              distance: 120,
              name: 'Jalan Tunjungan',
              maneuver: { type: 'depart', location: [112.7521, -7.2575] },
            },
            {
              distance: 5000,
              name: 'Jalan Basuki Rahmat',
              maneuver: { type: 'turn', modifier: 'left' },
            },
            { distance: 0, name: '', maneuver: { type: 'arrive' } },
          ],
        },
      ],
    },
  ],
}

// "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is the polyline5 sample of the format's documentation; as polyline6 it is the same points / 10
const valhallaOk = {
  trip: {
    summary: { length: 6.1, time: 900 },
    legs: [
      {
        shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
        maneuvers: [
          { instruction: 'Drive south on Jalan Tunjungan.', length: 0.2, begin_shape_index: 1 },
          { instruction: 'You have arrived at your destination.', length: 0 },
        ],
      },
    ],
  },
}

function setup(fetchImpl: FetchLike) {
  const host = memoryHost({ plugins: [createMapsPlugin({ fetch: fetchImpl, minGapMs: 0 })] })
  host.add('mia')
  return host
}
type Out = Record<string, unknown> & {
  steps?: { text: string; distanceM?: number; at?: unknown }[]
  results?: unknown[]
}
const call = (host: ReturnType<typeof setup>, op: string, input: unknown) =>
  host.call('maps', op, input, 'mia') as Promise<Out>
const fails = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    const e = error as { code?: string; message: string }
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a refusal')
}

describe('maps: route', () => {
  test('asks FOSSGIS OSRM with the positions and maps its answer; the line only when asked', async () => {
    const urls: string[] = []
    const host = setup(async (url) => {
      urls.push(url)
      return Response.json(osrmOk)
    })
    const out = await call(host, 'route', { from: A, to: B, mode: 'bike' })
    expect(urls[0]).toBe(
      'https://routing.openstreetmap.de/routed-bike/route/v1/driving/112.752100,-7.257500;112.739800,-7.290500?overview=full&geometries=geojson&steps=true',
    )
    expect(out).toMatchObject({
      from: A,
      to: B,
      mode: 'bike',
      provider: 'osrm',
      distanceM: 5235,
      durationS: 812,
      summary: '5.2 km, 14 min',
      bbox: [-7.2905, -7.2575, 112.7398, 112.7521],
    })
    expect(out.steps?.map((s) => s.text)).toEqual([
      'Start on Jalan Tunjungan',
      'Turn left onto Jalan Basuki Rahmat',
      'Arrive at the destination',
    ])
    expect(out.geometry).toBeUndefined()
    const lined = await call(host, 'route', { from: A, to: B, geometry: true })
    expect(lined.geometry).toEqual([
      [-7.2575, 112.7521],
      [-7.27, 112.7455],
      [-7.2905, 112.7398],
    ])
    expect(urls[1]).toContain('/routed-car/')
    // the window gets each turn's position; a chat answer does not
    expect(lined.steps?.[0]).toEqual({
      text: 'Start on Jalan Tunjungan',
      distanceM: 120,
      at: [-7.2575, 112.7521],
    })
    expect(out.steps?.[0]).not.toHaveProperty('at')
  })

  test('place names are looked up first; an unknown name is refused', async () => {
    const host = setup(async (url) => {
      if (url.includes('nominatim')) {
        const q = new URL(url).searchParams.get('q')
        if (q === 'nowhere') return Response.json([])
        return Response.json([{ lat: String(A.lat), lon: String(A.lon), display_name: q }])
      }
      if (url.includes('photon')) return Response.json({ features: [] })
      return Response.json(osrmOk)
    })
    const out = await call(host, 'route', { from: 'Tunjungan Plaza', to: B })
    expect(out.from).toEqual({ name: 'Tunjungan Plaza', ...A })
    expect(await fails(call(host, 'route', { from: 'nowhere', to: B }))).toEqual({
      code: 'CONFLICT',
      message: 'no place found for "nowhere"',
    })
  })

  test('OSRM down: Valhalla answers (POST JSON); a motorcycle asks Valhalla first, off motorways', async () => {
    const seen: { url: string; body: unknown }[] = []
    const host = setup(async (url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.includes('routing.openstreetmap.de')) throw new TypeError('fetch failed')
      return Response.json(valhallaOk)
    })
    const out = await call(host, 'route', { from: A, to: B, mode: 'foot' })
    expect(out).toMatchObject({ provider: 'valhalla', distanceM: 6100, summary: '6.1 km, 15 min' })
    expect(seen[1]?.url).toBe('https://valhalla1.openstreetmap.de/route')
    expect(seen[1]?.body).toMatchObject({ costing: 'pedestrian', locations: [A, B] })
    const lined = await call(host, 'route', { from: A, to: B, mode: 'foot', geometry: true })
    expect(lined.steps?.[0]).toMatchObject({ at: [4.07, -12.095] })
    seen.length = 0
    await call(host, 'route', { from: A, to: B, mode: 'motorcycle' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toMatchObject({
      costing: 'motorcycle',
      costing_options: { motorcycle: { use_highways: 0 } },
    })
  })

  test('a motorcycle with Valhalla down gets a car route, said in note', async () => {
    const host = setup(async (url) =>
      url.includes('valhalla') ? new Response('', { status: 502 }) : Response.json(osrmOk),
    )
    const out = await call(host, 'route', { from: A, to: B, mode: 'motorcycle' })
    expect(out).toMatchObject({ provider: 'osrm', note: expect.stringContaining('car route') })
  })

  test('no route is refused and not retried elsewhere; both down tells the first failure', async () => {
    let calls = 0
    const none = setup(async () => {
      calls++
      return Response.json({ code: 'NoRoute', routes: [] })
    })
    expect(await fails(call(none, 'route', { from: A, to: B }))).toEqual({
      code: 'CONFLICT',
      message: 'no route found between these places',
    })
    expect(calls).toBe(1)
    const valhallaNone = setup(async (url) =>
      url.includes('valhalla')
        ? Response.json({ error_code: 442 }, { status: 400 })
        : new Response('', { status: 503 }),
    )
    expect((await fails(call(valhallaNone, 'route', { from: A, to: B }))).message).toBe(
      'no route found between these places',
    )
    const down = setup(async () => new Response('', { status: 503 }))
    expect(await fails(call(down, 'route', { from: A, to: B }))).toEqual({
      code: 'CONFLICT',
      message: 'the route service failed (HTTP 503)',
    })
  })

  test('at most 3 stops; the operations are reads of outside data', async () => {
    const host = setup(async () => Response.json(osrmOk))
    expect((await fails(call(host, 'route', { from: A, to: B, via: [A, A, A, A] }))).code).toBe(
      'INVALID_INPUT',
    )
    for (const name of ['route', 'nearby']) {
      const op = maps.operation(name)
      expect(op?.toolName).toBe(`maps_${name}`)
      expect(op?.source).toBe('outside')
      expect(op?.risk).toBe('read')
    }
  })

  test('step text, long step lists, distance and duration', () => {
    expect(
      osrmStepText(
        { distance: 1, name: 'Jl. A', maneuver: { type: 'roundabout', exit: 2 } },
        false,
      ),
    ).toBe('At the roundabout take exit 2 onto Jl. A')
    expect(osrmStepText({ distance: 1, maneuver: { type: 'arrive' } }, false)).toBe(
      'Arrive at the stop',
    )
    expect(
      osrmStepText({ distance: 1, name: '', maneuver: { type: 'turn', modifier: 'uturn' } }, true),
    ).toBe('Make a U-turn')
    const many = Array.from({ length: 40 }, (_, i) => ({ text: `s${i}`, distanceM: 10 }))
    const trimmed = trimSteps(many)
    expect(trimmed).toHaveLength(30)
    expect(trimmed[29]).toEqual({ text: '10 more steps, then: s39', distanceM: 110 })
    expect([formatDistance(340), formatDistance(12_345), formatDuration(30)]).toEqual([
      '340 m',
      '12 km',
      '1 min',
    ])
    expect(formatDuration(5_000)).toBe('1 h 23 min')
  })
})

describe('maps: nearby', () => {
  const elements = {
    elements: [
      {
        type: 'node',
        lat: -7.26,
        lon: 112.752,
        tags: { amenity: 'pharmacy', name: 'Far', opening_hours: '24/7' },
      },
      {
        type: 'way',
        center: { lat: -7.2576, lon: 112.7521 },
        tags: {
          amenity: 'pharmacy',
          name: 'Near',
          'addr:street': 'Jalan Tunjungan',
          'addr:housenumber': '5',
        },
      },
      { type: 'node', lat: -7.258, lon: 112.752, tags: { amenity: 'pharmacy' } },
    ],
  }

  test('asks Overpass with the fixed filter around the point; nearest first', async () => {
    const bodies: string[] = []
    const host = setup(async (_url, init) => {
      bodies.push(decodeURIComponent(String(init?.body).slice(5)))
      return Response.json(elements)
    })
    const out = await call(host, 'nearby', { near: A, kind: 'pharmacy', radius: 500, limit: 2 })
    expect(bodies[0]).toBe(
      '[out:json][timeout:15];(nwr["amenity"="pharmacy"](around:500,-7.257500,112.752100););out center tags 100;',
    )
    expect(out.center).toEqual(A)
    expect(out.results).toEqual([
      {
        name: 'Near',
        lat: -7.2576,
        lon: 112.7521,
        kind: 'pharmacy',
        distanceM: 11,
        address: 'Jalan Tunjungan 5',
      },
      { name: 'pharmacy', lat: -7.258, lon: 112.752, kind: 'pharmacy', distanceM: 57 },
    ])
  })

  test('Overpass unreachable: Photon answers (nearest first); both down: the mirror', async () => {
    const photon = {
      features: [
        {
          geometry: { coordinates: [112.7352635, -7.259544] },
          properties: { name: 'Mandiri', osm_value: 'atm', street: 'Jalan Kedung Turi II' },
        },
        { geometry: { coordinates: [112.7521, -7.2576] }, properties: { osm_value: 'atm' } },
      ],
    }
    const urls: string[] = []
    const host = setup(async (url) => {
      urls.push(url)
      if (url.includes('overpass-api.de')) throw new DOMException('timed out', 'TimeoutError')
      return url.includes('photon') ? Response.json(photon) : Response.json(elements)
    })
    const out = await call(host, 'nearby', { near: A, kind: 'hotel', radius: 2_000, limit: 5 })
    expect(out.source).toBe('photon')
    expect(out.results).toEqual([
      { name: 'atm', lat: -7.2576, lon: 112.7521, kind: 'atm', distanceM: 11 },
      {
        name: 'Mandiri',
        lat: -7.259544,
        lon: 112.7352635,
        kind: 'atm',
        distanceM: 1871,
        address: 'Jalan Kedung Turi II',
      },
    ])
    expect(urls[1]).toBe(
      'https://photon.komoot.io/reverse?lat=-7.257500&lon=112.752100&radius=2&limit=5&osm_tag=tourism%3Ahotel&osm_tag=tourism%3Aguest_house&osm_tag=tourism%3Ahostel&osm_tag=tourism%3Amotel',
    )
    urls.length = 0
    const mirror = setup(async (url) => {
      urls.push(url)
      return url.includes('kumi') ? Response.json(elements) : new Response('', { status: 429 })
    })
    const viaMirror = await call(mirror, 'nearby', {
      near: A,
      tag: { key: 'cuisine', value: 'padang' },
    })
    expect(viaMirror.source).toBe('overpass')
    expect(viaMirror.results).toHaveLength(3)
    expect(urls).toEqual([
      'https://overpass-api.de/api/interpreter',
      'https://photon.komoot.io/reverse?lat=-7.257500&lon=112.752100&radius=1&limit=10&osm_tag=cuisine%3Apadang',
      'https://overpass.kumi.systems/api/interpreter',
    ])
  })

  test('a kind or a tag is required; a tag cannot break the query', async () => {
    const host = setup(async () => Response.json(elements))
    expect((await fails(call(host, 'nearby', { near: A }))).code).toBe('INVALID_INPUT')
    expect(
      (await fails(call(host, 'nearby', { near: A, tag: { key: 'name', value: 'x"];out;' } })))
        .code,
    ).toBe('INVALID_INPUT')
    expect(tagFilter({ key: 'shop' })).toBe('["shop"]')
    expect(overpassQuery(['["a"="b"]', '["c"]'], 1, 2, 50, 10)).toContain(
      'nwr["a"="b"](around:50,1.000000,2.000000);nwr["c"](around:50,1.000000,2.000000);',
    )
  })
})

describe('maps: upstream spacing', () => {
  test('requests to one host are spaced by minGapMs; other hosts do not wait; past 10 s it is busy', async () => {
    let clock = 0
    const waits: number[] = []
    const up = createUpstream({
      fetch: async () => Response.json({}),
      minGapMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    const signal = new AbortController().signal
    await up.json('https://a.example/1', { signal })
    await up.json('https://a.example/2', { signal })
    await up.json('https://b.example/1', { signal })
    expect(waits).toEqual([1_000])
    for (let i = 0; i < 9; i++) await up.json('https://a.example/x', { signal })
    await expect(up.json('https://a.example/y', { signal })).rejects.toMatchObject({
      kind: 'busy',
    })
    clock = 60_000
    await up.json('https://a.example/z', { signal })
  })
})

describe('maps: geometry', () => {
  test('decodes the documented polyline sample', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ])
    expect(decodePolyline('_p~iF~ps|U', 6)).toEqual([[3.85, -12.02]])
  })

  test('simplify keeps the ends and the corners, and fits the cap', () => {
    const line: LatLon[] = Array.from({ length: 5_000 }, (_, i) => [i * 0.0001, 0] as LatLon)
    line.push([0.5, 0.5])
    const out = simplify(line, 100)
    expect(out[0]).toEqual([0, 0])
    expect(out.at(-1)).toEqual([0.5, 0.5])
    expect(out).toContainEqual([0.4999, 0])
    expect(out.length).toBeLessThanOrEqual(3)
    const zigzag: LatLon[] = Array.from({ length: 4_000 }, (_, i) => [i * 0.001, (i % 2) * 0.01])
    expect(simplify(zigzag, 500).length).toBeLessThanOrEqual(500)
  })

  test('haversine and bbox', () => {
    expect(Math.round(haversine([0, 0], [0, 1]))).toBe(111_195)
    expect(
      bboxOf([
        [1, 2],
        [-3, 4],
      ]),
    ).toEqual([-3, 1, 2, 4])
  })
})
