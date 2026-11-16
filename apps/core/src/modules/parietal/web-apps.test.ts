import { describe, expect, test } from 'bun:test'
import { emptyWorkspace } from '@keith/contracts'
import { z } from 'zod'
import { appsLine, catalogOf, checkAppOps, openableBy, parseParams, webAppOf } from './web-apps.ts'

// The window apps (docs/specs/plugin-web-apps.md): the contributions to `web.window` shaped for the tool, the SPA and the
// workspace's own check of `window.open` and `window.setParams` (ADR-0038 §8).

const MAP = {
  contributor: 'maps',
  id: 'map',
  entry: {
    id: 'map',
    title: 'Map',
    description: 'a map',
    params: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      zoom: z.number().int().min(1).max(19).default(13),
    }),
    entry: { path: './web/map.html' },
    network: ['https://tile.openstreetmap.org'],
    calls: ['search'],
  },
}
const SECRET = {
  contributor: 'vault',
  id: 'safe',
  entry: {
    id: 'safe',
    title: 'Safe',
    params: z.object({}),
    entry: { builtin: 'safe' },
    permission: 'vault.open',
  },
}

describe('catalog', () => {
  test('no contribution (web off) falls back to the built-in screens', () => {
    const ids = catalogOf([]).map((a) => a.id)
    expect(ids).toContain('web:tasks')
    expect(catalogOf([]).every((a) => a.app.singleton)).toBe(true)
  })

  test('a contribution becomes <contributor>:<id>; one that does not read is skipped', () => {
    const catalog = catalogOf([MAP, { contributor: 'x', id: 'bad', entry: { id: 'bad' } }])
    expect(catalog.map((a) => a.id)).toEqual(['maps:map'])
  })

  test('the SPA view: the page under /plugins/<id>/, full call names, params as JSON Schema', () => {
    const app = webAppOf(catalogOf([MAP])[0] as never)
    expect(app).toMatchObject({
      id: 'maps:map',
      entry: { url: '/plugins/maps/web/map.html' },
      calls: ['maps.search'],
      network: ['https://tile.openstreetmap.org'],
      singleton: false,
      params: { type: 'object', properties: { lat: { type: 'number' } } },
    })
  })

  test('permission filters what a person may open', () => {
    const catalog = catalogOf([MAP, SECRET])
    expect(openableBy(catalog, () => false).map((a) => a.id)).toEqual(['maps:map'])
    expect(openableBy(catalog, (c) => c === 'vault.open')).toHaveLength(2)
  })

  test('the tool line names each app and the params of one that takes any', () => {
    const line = appsLine(catalogOf([MAP, SECRET]))
    expect(line).toContain('maps:map (a map; params {"lat"')
    expect(line).toContain('vault:safe (Safe)')
  })

  test('params are parsed with the app schema, defaults filled in', () => {
    const map = catalogOf([MAP])[0] as never
    expect(parseParams(map, { lat: -7.25, lon: 112.75 })).toEqual({
      ok: true,
      params: { lat: -7.25, lon: 112.75, zoom: 13 },
    })
    expect(parseParams(map, { lat: 200, lon: 0 })).toMatchObject({ ok: false })
  })
})

describe('checkAppOps', () => {
  const catalog = catalogOf([MAP])
  const doc = emptyWorkspace()

  test('an unknown app and params that do not fit are refused with the index', () => {
    expect(
      checkAppOps(catalog, doc, [
        { op: 'window.open', desktopId: 'd1', id: 'w1', app: 'nope:x', title: 'X' },
      ]),
    ).toEqual({ error: 'unknown-app', at: 0 })
    expect(
      checkAppOps(catalog, doc, [
        { op: 'desktop.add', id: 'd2', name: 'Two' },
        {
          op: 'window.open',
          desktopId: 'd1',
          id: 'w1',
          app: 'maps:map',
          title: 'Map',
          params: { lat: 'x' },
        },
      ]),
    ).toEqual({ error: 'bad-params', at: 1 })
  })

  test('setParams on a window opened in the same list is checked against its app', () => {
    expect(
      checkAppOps(catalog, doc, [
        {
          op: 'window.open',
          desktopId: 'd1',
          id: 'w1',
          app: 'maps:map',
          title: 'Map',
          params: { lat: 1, lon: 2 },
        },
        { op: 'window.setParams', id: 'w1', params: { lat: 1, lon: 999 } },
      ]),
    ).toEqual({ error: 'bad-params', at: 1 })
    expect(
      checkAppOps(catalog, doc, [
        {
          op: 'window.open',
          desktopId: 'd1',
          id: 'w1',
          app: 'maps:map',
          title: 'Map',
          params: { lat: 1, lon: 2 },
        },
        { op: 'window.setParams', id: 'w1', params: { lat: 3, lon: 4, zoom: 15 } },
      ]),
    ).toBeUndefined()
  })
})
