import { defineKeithPlugin, type KeithPlugin, PLUGIN_API_VERSION } from '@keith/host'
import { z } from '@keith/host/schema'
import { CAMERA_ORIGINS } from './layers/cameras.ts'
import { IMAGERY_ORIGINS } from './layers/imagery.ts'
import {
  createProviders,
  exploreOperation,
  type LayerOptions,
  layersOperation,
} from './layers/index.ts'
import { MapsConfig } from './layers/types.ts'
import { nearbyOperation } from './nearby.ts'
import { MODES, routeOperation } from './route.ts'
import { searchOperation } from './search.ts'
import { createUpstream, type FetchLike } from './upstream.ts'
import { LAYER_IDS } from './web/catalog.js'
import { MARK_COLORS, MARK_KINDS, MAX_MARK_POINTS, MAX_MARKS } from './web/params.js'
import { STYLE_ORIGINS } from './web/styles.js'

const lat = z.number().min(-90).max(90)
const lon = z.number().min(-180).max(180)
const Pin = z.object({ lat, lon, label: z.string().max(40).optional() })

/** The base map styles of the map window; each one's hosts are in `network` (the core's net route allows only those). */
export const MAP_STYLES = [
  'dark',
  'satellite',
  'night',
  'standard',
  'mono',
  'topo',
  'humanitarian',
  'cycle',
] as const

const Mark = z.object({
  kind: z.enum(MARK_KINDS),
  points: z
    .array(z.tuple([lat, lon]))
    .min(1)
    .max(MAX_MARK_POINTS),
  label: z.string().max(40).optional(),
  color: z.enum(MARK_COLORS).optional(),
})

/** CesiumJS's built files (the page loads `./vendor/cesium/Cesium.js`): served from the installed package, never copied. */
export const CESIUM_DIR = Bun.resolveSync('cesium/package.json', import.meta.dir).replace(
  /package\.json$/,
  'Build/Cesium',
)

/**
 * The window app `maps:map` (point `web.window`, ADR-0038 §4, ADR-0040): a globe that morphs to a flat map, with a route, pins,
 * marks and live data layers. `gpu` lets CesiumJS run (WebGL, wasm, blob workers); `media` lets it play radio streams; `live` hosts
 * are camera snapshots, kept 20 s in the core's net cache instead of a day.
 */
export const mapWindow = {
  id: 'map',
  title: 'World',
  icon: '◍',
  description:
    'Globe or flat map (view "2d") at lat, lon, zoom: label, style, pins (places), a route it draws, marks, and live layers (flights, vessels, transit, satellites, quakes, weather, cameras, radio…)',
  params: z.object({
    lat,
    lon,
    zoom: z.number().min(1).max(19).default(13),
    label: z.string().max(80).optional(),
    style: z.enum(MAP_STYLES).optional(),
    view: z.enum(['3d', '2d']).optional(),
    layers: z
      .array(z.enum(LAYER_IDS as [string, ...string[]]))
      .max(8)
      .optional(),
    route: z
      .object({
        from: Pin,
        to: Pin,
        via: z.array(Pin).max(3).optional(),
        mode: z.enum(MODES).optional(),
      })
      .optional(),
    places: z.array(Pin).max(20).optional(),
    marks: z
      .array(Mark)
      .max(MAX_MARKS)
      .refine((marks) => marks.reduce((n, m) => n + m.points.length, 0) <= MAX_MARK_POINTS, {
        message: `at most ${MAX_MARK_POINTS} points in all marks`,
      })
      .optional(),
    /** Set by the window once it has fitted the view to this route and these pins: the person's pan and zoom are kept after that. */
    fitted: z.string().max(400).optional(),
  }),
  entry: { path: './web/map.html' },
  network: [...new Set([...STYLE_ORIGINS, ...CAMERA_ORIGINS, ...IMAGERY_ORIGINS])],
  live: CAMERA_ORIGINS,
  gpu: true,
  media: true,
  calls: ['search', 'route', 'layers'],
  singleton: false,
}

/**
 * Maps (docs/specs/plugins/maps.md): `maps_search` finds a place, `maps_route` a route, `maps_nearby` places of a kind nearby, all on
 * OpenStreetMap services, and `maps_explore` reads a live data layer around a place; the `maps:map` window shows them on a globe.
 * `fetch` (and the AIS socket) are injectable for tests, and `minGapMs` (the spacing of requests to one host, 1 s by default) is 0
 * there.
 */
export function createMapsPlugin(
  options: { fetch?: FetchLike; minGapMs?: number } & LayerOptions = {},
): KeithPlugin {
  const up = createUpstream({
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    minGapMs: options.minGapMs,
  })
  const providers = createProviders(
    up,
    options.socket === undefined ? {} : { socket: options.socket },
  )
  return defineKeithPlugin({
    id: 'maps',
    version: '0.3.0',
    apiVersion: PLUGIN_API_VERSION,
    title: 'Maps',
    description:
      'Find places, routes and nearby places on OpenStreetMap, read live layers (flights, ships, transit, satellites, quakes, weather, public cameras, radio, recent imagery) and show them on a globe window.',
    config: MapsConfig,
    web: { dir: `${import.meta.dir}/web`, mounts: { 'vendor/cesium': CESIUM_DIR } },
    contributes: { 'web.window': [mapWindow] },
    operations: [
      searchOperation(up),
      routeOperation(up),
      nearbyOperation(up),
      layersOperation(providers),
      exploreOperation(up, providers),
    ],
  })
}

export default createMapsPlugin()
