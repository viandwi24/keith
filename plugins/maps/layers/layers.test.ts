import { describe, expect, test } from 'bun:test'
import { createUpstream, type FetchLike } from '../upstream.ts'
import {
  finlandCameras,
  hongKongCameras,
  osmCameraQuery,
  overlaps,
  singaporeCameras,
  tflCameras,
} from './cameras.ts'
import { bmkgQuakes, eonetEvents, usgsQuakes } from './events.ts'
import { aircraftFeatures } from './flights.ts'
import { sceneFeatures, searchBody } from './imagery.ts'
import { answerLayer, bboxAround, createProviders, zoomForRadius } from './index.ts'
import { stationFeatures } from './radio.ts'
import { trackOf } from './space.ts'
import { decodeVehicles, fieldsOf } from './transit.ts'
import { type Bbox, centreOf, inBbox, type LayerQuery, netPath } from './types.ts'
import { applyMessage, shipFeatures, subscription } from './vessels.ts'
import { airFeatures, gridOf, rainTemplate, weatherFeatures } from './weather.ts'

const NOW = Date.parse('2026-11-16T12:00:00Z')

describe('maps layers: shared helpers', () => {
  test('inBbox and centreOf handle the antimeridian', () => {
    const across: Bbox = [-10, 10, 170, -170]
    expect(inBbox(across, 0, 175)).toBe(true)
    expect(inBbox(across, 0, -175)).toBe(true)
    expect(inBbox(across, 0, 0)).toBe(false)
    expect(centreOf(across).lon).toBeCloseTo(-180, 6)
    expect(overlaps([51, 52, -1, 1], across)).toBe(false)
    expect(overlaps([0, 1, 175, 179], across)).toBe(true)
  })

  test('netPath keeps plain https paths only', () => {
    expect(netPath('https://tdcctv.data.one.gov.hk/H429F.JPG')).toBe(
      '../net/tdcctv.data.one.gov.hk/H429F.JPG',
    )
    expect(netPath('http://x.example/a.jpg')).toBeUndefined()
    expect(netPath('https://x.example/a.jpg?t=1')).toBeUndefined()
    expect(netPath('not a url')).toBeUndefined()
  })

  test('bboxAround and zoomForRadius', () => {
    const b = bboxAround(0, 0, 111.32)
    expect(b[0]).toBeCloseTo(-1, 6)
    expect(b[3]).toBeCloseTo(1, 6)
    expect(zoomForRadius(1)).toBeGreaterThan(zoomForRadius(100))
  })
})

describe('maps layers: sources', () => {
  test('aircraft: callsign, altitude in metres, speed in m/s, stale fixes dropped', () => {
    const out = aircraftFeatures(
      [
        {
          hex: 'abc',
          lat: -7.3,
          lon: 112.8,
          flight: 'GIA123 ',
          alt_baro: 10000,
          gs: 400,
          track: 90,
          t: 'B738',
        },
        { hex: 'def', lat: 1, lon: 1, seen_pos: 120 },
        { hex: 'mil', lat: 1, lon: 1, alt_baro: 'ground', dbFlags: 1 },
      ],
      NOW,
      'test',
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: 'ac:abc',
      label: 'GIA123',
      alt: 3048,
      heading: 90,
      kind: 'airborne',
    })
    expect(out[0]?.speed).toBeCloseTo(205.8, 1)
    expect(out[1]).toMatchObject({ kind: 'military', alt: 0 })
  })

  test('quakes from USGS and BMKG', () => {
    const usgs = usgsQuakes({
      features: [
        {
          id: 'us1',
          properties: { mag: 5.1, place: 'Banda Sea', time: NOW, tsunami: 0 },
          geometry: { coordinates: [128, -6, 120] },
        },
      ],
    })
    expect(usgs[0]).toMatchObject({ lat: -6, lon: 128, size: 5.1, label: 'M5.1', kind: 'quake' })
    expect(usgs[0]?.info?.Depth).toBe('120 km')
    const bmkg = bmkgQuakes({
      Infogempa: {
        gempa: [
          {
            DateTime: '2026-11-15T20:51:57+00:00',
            Coordinates: '-5.97,128.82',
            Magnitude: '5.4',
            Kedalaman: '323 km',
            Wilayah: 'Maluku',
            Potensi: 'Tidak berpotensi tsunami',
          },
          { Coordinates: '1,2', Magnitude: '7.1', Potensi: 'Berpotensi tsunami' },
        ],
      },
    })
    expect(bmkg[0]).toMatchObject({ lat: -5.97, lon: 128.82, size: 5.4, kind: 'quake' })
    expect(bmkg[1]?.kind).toBe('tsunami warning')
  })

  test('EONET: the last point is the place, earlier points a line', () => {
    const out = eonetEvents({
      events: [
        {
          id: 'E1',
          title: 'Typhoon X',
          categories: [{ title: 'Severe Storms' }],
          geometry: [
            { type: 'Point', date: '2026-11-14T00:00:00Z', coordinates: [130, 10] },
            {
              type: 'Point',
              date: '2026-11-15T00:00:00Z',
              coordinates: [128, 12],
              magnitudeValue: 90,
              magnitudeUnit: 'kts',
            },
          ],
        },
        { id: 'E2', geometry: [{ type: 'Polygon', coordinates: [] }] },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ lat: 12, lon: 128, kind: 'Severe Storms' })
    expect(out[0]?.line).toEqual([
      [10, 130],
      [12, 128],
    ])
  })

  test('satellite tracks propagate with SGP4', () => {
    const iss = {
      OBJECT_NAME: 'ISS (ZARYA)',
      OBJECT_ID: '1998-067A',
      EPOCH: '2026-11-16T00:00:00.000000',
      MEAN_MOTION: 15.5,
      ECCENTRICITY: 0.0005,
      INCLINATION: 51.64,
      RA_OF_ASC_NODE: 100,
      ARG_OF_PERICENTER: 90,
      MEAN_ANOMALY: 270,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: 'U',
      NORAD_CAT_ID: 25544,
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 1,
      BSTAR: 0.0001,
      MEAN_MOTION_DOT: 0.0001,
      MEAN_MOTION_DDOT: 0,
    }
    const track = trackOf(iss, NOW)
    expect(track).toHaveLength(23)
    for (const [, lat, , alt] of track ?? []) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(52)
      expect(alt).toBeGreaterThan(300_000)
      expect(alt).toBeLessThan(500_000)
    }
    expect(trackOf({ OBJECT_NAME: 'junk' }, NOW)).toBeUndefined()
  })

  test('weather and air quality on a grid', () => {
    const grid = gridOf([0, 4, 100, 106], 3, 2)
    expect(grid).toHaveLength(6)
    expect(grid[0]).toEqual({ lat: 1, lon: 101 })
    const wx = weatherFeatures(
      [
        {
          current: {
            temperature_2m: 30.4,
            weather_code: 61,
            wind_speed_10m: 12,
            wind_direction_10m: 90,
          },
        },
      ],
      grid,
    )
    expect(wx[0]).toMatchObject({ label: '30°', kind: 'light rain', value: 30.4, heading: 270 })
    const aq = airFeatures({ current: { us_aqi: 160, pm2_5: 70.2 } }, grid)
    expect(aq[0]).toMatchObject({ kind: 'unhealthy', value: 160 })
    expect(rainTemplate(NOW)).toContain(
      '/default/2026-11-15/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
    )
  })

  test('cameras of each operator, with snapshots through the net route', () => {
    expect(
      tflCameras([
        {
          id: 'J1',
          commonName: 'A406',
          lat: 51.5,
          lon: -0.1,
          additionalProperties: [
            {
              key: 'imageUrl',
              value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.jpg',
            },
          ],
        },
        {
          id: 'J2',
          lat: 51.5,
          lon: -0.1,
          additionalProperties: [{ key: 'available', value: 'false' }],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'cam:TfL:J1',
        image: '../net/s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.jpg',
      }),
    ])
    expect(
      singaporeCameras({
        items: [
          {
            cameras: [
              {
                camera_id: '2701',
                image: 'https://images.data.gov.sg/api/a.jpg',
                location: { latitude: 1.4, longitude: 103.7 },
              },
            ],
          },
        ],
      })[0]?.image,
    ).toBe('../net/images.data.gov.sg/api/a.jpg')
    const hk = hongKongCameras(
      '<image-list><image><key>H429F</key><district>Southern</district><description>Aberdeen &amp; Praya</description><latitude>22.24845</latitude><longitude>114.1505</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image></image-list>',
    )
    expect(hk[0]).toMatchObject({
      label: 'Aberdeen & Praya',
      image: '../net/tdcctv.data.one.gov.hk/H429F.JPG',
    })
    const fi = finlandCameras({
      features: [
        {
          geometry: { coordinates: [24, 60] },
          properties: {
            id: 'C01503',
            name: 'kt51_Inkoo',
            collectionStatus: 'GATHERING',
            presets: [{ id: 'C0150301', inCollection: true }],
          },
        },
      ],
    })
    expect(fi[0]).toMatchObject({
      label: 'kt51 Inkoo',
      image: '../net/weathercam.digitraffic.fi/C0150301.jpg',
    })
    expect(osmCameraQuery([1, 2, 3, 4])).toContain(
      'node["man_made"="surveillance"](1.00000,3.00000,2.00000,4.00000)',
    )
  })

  test('radio keeps https streams once, without HLS', () => {
    const out = stationFeatures([
      {
        stationuuid: 'a',
        name: 'Delta FM',
        url_resolved: 'https://stream.example/a',
        geo_lat: -6.2,
        geo_long: 106.8,
        codec: 'MP3',
        bitrate: 128,
      },
      {
        stationuuid: 'b',
        name: 'Delta FM',
        url_resolved: 'https://stream.example/a',
        geo_lat: -6.2,
        geo_long: 106.8,
      },
      {
        stationuuid: 'c',
        name: 'Plain',
        url_resolved: 'http://stream.example/c',
        geo_lat: 1,
        geo_long: 1,
      },
      {
        stationuuid: 'd',
        name: 'Hls',
        url_resolved: 'https://x.example/d.m3u8',
        hls: 1,
        geo_lat: 1,
        geo_long: 1,
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      stream: 'https://stream.example/a',
      info: { Stream: 'MP3 128 kbps' },
    })
  })

  test('imagery: the newest clear scene per tile, draped on its bbox', () => {
    const scene = (id: string, cc: number) => ({
      id,
      bbox: [105.9, -6.42, 106.9, -5.42],
      properties: { datetime: '2026-11-09T03:19:43Z', 'eo:cloud_cover': cc },
      assets: {
        thumbnail: { href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/x/${id}/preview.jpg` },
      },
    })
    const out = sceneFeatures({
      features: [
        scene('S2A_48MXU_20261116_0_L2A', 100),
        scene('S2B_48MXU_20261109_0_L2A', 30),
        scene('S2C_48MXU_20261104_0_L2A', 5),
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ rect: [-6.42, -5.42, 105.9, 106.9], label: '2026-11-09' })
    expect(JSON.parse(searchBody([0, 1, 2, 3], NOW)).datetime).toBe(
      '2026-10-02T00:00:00Z/2026-11-16T23:59:59Z',
    )
  })
})

/** A protobuf writer just for the test: varints, length-delimited fields and fixed32 floats. */
function pb(fields: [number, number | string | Uint8Array | { f32: number }][]): Uint8Array {
  const out: number[] = []
  const varint = (v: number) => {
    while (v >= 128) {
      out.push((v % 128) | 128)
      v = Math.floor(v / 128)
    }
    out.push(v)
  }
  for (const [no, v] of fields) {
    if (typeof v === 'number') {
      varint(no * 8)
      varint(v)
    } else if (typeof v === 'object' && 'f32' in v) {
      varint(no * 8 + 5)
      const b = new Uint8Array(4)
      new DataView(b.buffer).setFloat32(0, v.f32, true)
      out.push(...b)
    } else {
      const b = typeof v === 'string' ? new TextEncoder().encode(v) : v
      varint(no * 8 + 2)
      varint(b.length)
      out.push(...b)
    }
  }
  return new Uint8Array(out)
}

describe('maps layers: GTFS-Realtime', () => {
  test('decodes vehicle positions', () => {
    const position = pb([
      [1, { f32: 3.1 }],
      [2, { f32: 101.6 }],
      [3, { f32: 90 }],
      [5, { f32: 10 }],
    ])
    const vehicle = pb([
      [1, pb([[5, 'T817']])],
      [2, position],
      [5, 1_794_830_000],
      [
        8,
        pb([
          [1, 'VAG4876'],
          [2, 'Bus 7'],
        ]),
      ],
    ])
    const feed = pb([
      [
        1,
        pb([
          [1, '2.0'],
          [3, 1_794_830_010],
        ]),
      ],
      [
        2,
        pb([
          [1, 'e1'],
          [4, vehicle],
        ]),
      ],
      [2, pb([[1, 'e2']])],
    ])
    expect(fieldsOf(pb([[1, 300]]))).toEqual([[1, 300, 0]])
    const { header, vehicles } = decodeVehicles(feed)
    expect(header).toBe(1_794_830_010)
    expect(vehicles).toHaveLength(1)
    expect(vehicles[0]).toMatchObject({
      id: 'VAG4876',
      route: 'T817',
      label: 'Bus 7',
      bearing: 90,
      timestamp: 1_794_830_000,
    })
    expect(vehicles[0]?.lat).toBeCloseTo(3.1, 5)
    expect(vehicles[0]?.speed).toBeCloseTo(10, 5)
    expect(() => fieldsOf(new Uint8Array([0x0a, 5, 1]))).toThrow()
  })
})

describe('maps layers: AIS', () => {
  test('folds position and static messages into ships', () => {
    const ships = new Map()
    applyMessage(
      ships,
      {
        MessageType: 'PositionReport',
        MetaData: { MMSI: 525001, ShipName: 'KM KELUD ', latitude: -6.1, longitude: 106.8 },
        Message: { PositionReport: { Sog: 12, Cog: 45, TrueHeading: 511, NavigationalStatus: 0 } },
      },
      NOW,
    )
    applyMessage(
      ships,
      {
        MessageType: 'ShipStaticData',
        MetaData: { MMSI: 525001 },
        Message: { ShipStaticData: { Destination: 'BELAWAN', Type: 60 } },
      },
      NOW,
    )
    const out = shipFeatures(ships, [-7, -5, 106, 107], NOW)
    expect(out[0]).toMatchObject({
      label: 'KM KELUD',
      kind: 'passenger',
      heading: 45,
      info: { Destination: 'BELAWAN', Speed: '12.0 kt' },
    })
    expect(shipFeatures(ships, [-7, -5, 106, 107], NOW + 16 * 60_000)).toHaveLength(0)
    expect(JSON.parse(subscription('k', [0, 1, 170, -170])).BoundingBoxes).toHaveLength(2)
  })
})

describe('maps layers: answers', () => {
  const quiet: FetchLike = async () => new Response('nope', { status: 500 })
  const query = (over: Partial<LayerQuery> = {}): LayerQuery => ({
    bbox: [-7.4, -7.1, 112.6, 112.9],
    zoom: 11,
    config: {},
    signal: new AbortController().signal,
    now: NOW,
    ...over,
  })

  test('a layer below its zoom says so; a missing setting says so; a failing source is an error', async () => {
    const providers = createProviders(createUpstream({ fetch: quiet, minGapMs: 0 }))
    expect((await answerLayer(providers, 'cameras', query({ zoom: 5 }))).note).toBe(
      'zoom in to 9 to see it',
    )
    expect((await answerLayer(providers, 'vessels', query())).note).toContain('aisstreamKey')
    expect((await answerLayer(providers, 'receivers', query())).note).toContain('receivers')
    const failed = await answerLayer(providers, 'flights', query())
    expect(failed.error).toContain('failed (HTTP 500)')
    const rain = await answerLayer(providers, 'rain', query())
    expect(rain.raster?.maxZoom).toBe(6)
    expect((await answerLayer(providers, 'nope', query())).error).toBe('unknown layer')
  })
})
