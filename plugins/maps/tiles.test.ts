import { describe, expect, test } from 'bun:test'
import { isNetPath, readAnswers } from './web/data.js'
import { moveAlong, trackAt } from './web/features.js'
import { fitKey, pinsOf, readMarks, readParams } from './web/params.js'
import {
  previewUrl,
  STYLE_ORIGINS,
  STYLES,
  styleName,
  styleOf,
  templateOf,
  tileUrl,
} from './web/styles.js'
import {
  clampZoom,
  fitView,
  heightForZoom,
  offsetPoint,
  project,
  spanForZoom,
  TILE,
  unproject,
  wrapLon,
  zoomForHeight,
  zoomForSpan,
} from './web/tiles.js'

describe('maps: web mercator math', () => {
  test('project puts (0, 0) in the middle of the world and round-trips through unproject', () => {
    expect(project(0, 0, 1)).toEqual({ x: TILE, y: TILE })
    for (const [lat, lon, z] of [
      [-7.2459717, 112.7378266, 13],
      [51.5, -0.12, 5],
      [-33.86, 151.2, 17],
    ] as const) {
      const p = project(lat, lon, z)
      const back = unproject(p.x, p.y, z)
      expect(back.lat).toBeCloseTo(lat, 6)
      expect(back.lon).toBeCloseTo(lon, 6)
    }
  })

  test('the tile of a point matches the OSM slippy-map formula', () => {
    const p = project(-7.2459717, 112.7378266, 13)
    expect(Math.floor(p.x / TILE)).toBe(6661)
    expect(Math.floor(p.y / TILE)).toBe(4261)
  })

  test('wrapLon and clampZoom keep values in range', () => {
    expect(wrapLon(190)).toBeCloseTo(-170)
    expect(wrapLon(-190)).toBeCloseTo(170)
    expect(clampZoom(0.2)).toBe(1)
    expect(clampZoom(25)).toBe(19)
    expect(clampZoom(12.345)).toBe(12.35)
  })

  test('fitView fits the points between levels and centres on them', () => {
    const v = fitView(
      [
        { lat: -7.25, lon: 112.74 },
        { lat: -6.2, lon: 106.82 },
      ],
      1000,
      700,
    )
    expect(v).toBeDefined()
    expect(v?.lon).toBeCloseTo(109.78, 2)
    // the deepest zoom where the span fits: floored to 0.05
    expect(((v?.zoom ?? 0) * 20) % 1).toBeCloseTo(0, 6)
    const span = project(-6.2, 112.74, v?.zoom ?? 0).x - project(-6.2, 106.82, v?.zoom ?? 0).x
    expect(span).toBeLessThanOrEqual(920)
    expect(span).toBeGreaterThan(850)
    expect(fitView([], 100, 100)).toBeUndefined()
  })

  test('offsetPoint moves the centre by screen pixels', () => {
    const p = offsetPoint(0, 0, 2, 256, 0)
    expect(p.lat).toBeCloseTo(0, 6)
    expect(p.lon).toBeCloseTo(90, 6)
  })

  test('camera height and zoom are inverse, and deeper zooms are lower', () => {
    for (const [z, lat] of [
      [3, 0],
      [12, -7.25],
      [17.5, 51.5],
    ] as const) {
      const h = heightForZoom(z, lat, 1200)
      expect(zoomForHeight(h, lat, 1200)).toBeCloseTo(z, 2)
    }
    expect(heightForZoom(10, 0, 1000)).toBeGreaterThan(heightForZoom(11, 0, 1000))
    // the whole world (40 075 km) on 1024 px is about zoom 2
    expect(zoomForSpan(40_075_016, 1024)).toBeCloseTo(2, 1)
    expect(zoomForSpan(spanForZoom(11.3, 900), 900)).toBeCloseTo(11.3, 6)
  })
})

describe('maps: styles', () => {
  test('every style has a known origin in the network list and a credit', () => {
    for (const [name, s] of Object.entries(STYLES)) {
      expect(STYLE_ORIGINS).toContain(s.base.origin)
      if (s.labels !== undefined) expect(STYLE_ORIGINS).toContain(s.labels.origin)
      expect(s.credit.length, name).toBeGreaterThan(0)
    }
    expect(styleName('nope')).toBe('dark')
    expect(styleName('night')).toBe('night')
  })

  test('tiles go through the net route', () => {
    expect(templateOf(styleOf('standard').base)).toBe(
      '../net/tile.openstreetmap.org/{z}/{x}/{y}.png',
    )
    expect(tileUrl(styleOf('standard').base, 3, 4, 5)).toBe(
      '../net/tile.openstreetmap.org/3/4/5.png',
    )
    expect(previewUrl(0, 0, 2, 'standard')).toMatch(
      /^\.\.\/net\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/,
    )
  })
})

describe('maps: params', () => {
  test('readParams keeps known layers once, the view and valid marks', () => {
    const p = readParams({
      lat: -7.25,
      lon: 112.74,
      zoom: 30,
      view: '2d',
      style: 'night',
      layers: ['flights', 'nope', 'flights', 'cameras'],
      marks: [
        { kind: 'pin', points: [[-7.25, 112.74]], label: ' here ', color: 'red' },
        { kind: 'line', points: [[-7.25, 112.74]] },
        {
          kind: 'area',
          points: [
            [1, 1],
            [1, 2],
            [2, 2],
          ],
          color: 'pink',
        },
      ],
    })
    expect(p?.zoom).toBe(19)
    expect(p?.view).toBe('2d')
    expect(p?.style).toBe('night')
    expect(p?.layers).toEqual(['flights', 'cameras'])
    expect(p?.marks).toEqual([
      { kind: 'pin', points: [[-7.25, 112.74]], label: 'here', color: 'red' },
      {
        kind: 'area',
        points: [
          [1, 1],
          [1, 2],
          [2, 2],
        ],
      },
    ])
    expect(readParams({ lat: 100, lon: 0 })).toBeUndefined()
    expect(readParams({ lat: 1, lon: 2 })?.view).toBe('3d')
  })

  test('readMarks caps the points across marks', () => {
    const line = { kind: 'line', points: Array.from({ length: 30 }, (_, i) => [0, i]) }
    const marks = readMarks([line, line])
    expect(marks.reduce((n, m) => n + m.points.length, 0)).toBe(40)
  })

  test('fitKey names the route and pins; pinsOf letters the stops', () => {
    const p = readParams({
      lat: 0,
      lon: 0,
      route: { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, via: [{ lat: 5, lon: 6 }] },
      places: [{ lat: 7, lon: 8 }],
    })
    if (p === undefined) throw new Error('params')
    expect(fitKey(p)).toBe('car:1.0000,2.0000;5.0000,6.0000;3.0000,4.0000|p:7.0000,8.0000')
    expect(pinsOf(p).map((x) => x.mark)).toEqual(['A', '1', 'B', ''])
  })
})

describe('maps: layer answers in the page', () => {
  test('isNetPath takes only paths through the net route', () => {
    expect(isNetPath('../net/tdcctv.data.one.gov.hk/H429F.JPG')).toBe(true)
    expect(isNetPath('../net/host/../auth/me')).toBe(false)
    expect(isNetPath('../net/host/a.jpg?x=1')).toBe(false)
    expect(isNetPath('https://evil.example/a.jpg')).toBe(false)
  })

  test('readAnswers drops bad features and media the page may not load', () => {
    const out = readAnswers({
      layers: [
        {
          id: 'cameras',
          features: [
            { id: 'a', lat: 1, lon: 2, image: '../net/h.example/a.jpg', label: 'x'.repeat(100) },
            { id: 'b', lat: 1, lon: 2, image: 'https://h.example/a.jpg', stream: 'http://radio' },
            { id: 'c', lat: 'x', lon: 2 },
          ],
        },
        {
          id: 'rain',
          features: [],
          raster: { template: '../net/g.example/{z}/{y}/{x}.png', maxZoom: 6 },
        },
        { id: 'bad', features: [], raster: { template: 'https://g.example/{z}.png' } },
      ],
    })
    expect(out[0]?.features).toHaveLength(2)
    expect(out[0]?.features[0]?.image).toBe('../net/h.example/a.jpg')
    expect(out[0]?.features[0]?.label).toHaveLength(80)
    expect(out[0]?.features[1]?.image).toBeUndefined()
    expect(out[0]?.features[1]?.stream).toBeUndefined()
    expect(out[1]?.raster?.maxZoom).toBe(6)
    expect(out[2]?.raster).toBeUndefined()
    expect(readAnswers(null)).toEqual([])
  })

  test('moveAlong and trackAt move things between answers', () => {
    const p = moveAlong(0, 0, 90, 111_195)
    expect(p.lat).toBeCloseTo(0, 4)
    expect(p.lon).toBeCloseTo(1, 2)
    const track: [number, number, number, number][] = [
      [0, 0, 0, 400_000],
      [1000, 0, 10, 400_000],
    ]
    expect(trackAt(track, 500)?.lon).toBeCloseTo(5, 1)
    expect(trackAt(track, -5)?.lon).toBe(0)
    expect(trackAt([], 1)).toBeUndefined()
  })
})
