// The data layers (docs/specs/plugins/maps.md "Data layers"): one provider per layer of `web/catalog.js`, the `layers` operation the
// map window calls for what is in its view, and `explore` (`maps_explore`), which lets the agent read a layer around a place.
import { defineOperation, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import { haversine } from '../geo.ts'
import { resolvePlace, Where } from '../route.ts'
import { failure, type Upstream } from '../upstream.ts'
import { LAYER_IDS, layerOf } from '../web/catalog.js'
import { camerasProvider } from './cameras.ts'
import { eventsProvider, quakesProvider } from './events.ts'
import { flightsProvider, receiversProvider } from './flights.ts'
import { imageryProvider } from './imagery.ts'
import { radioProvider } from './radio.ts'
import { launchesProvider, satellitesProvider } from './space.ts'
import { transitProvider } from './transit.ts'
import {
  Bbox,
  type Feature,
  LayerAnswer,
  type LayerQuery,
  MapsConfig,
  type Provider,
} from './types.ts'
import { type SocketLike, vesselsProvider } from './vessels.ts'
import { airProvider, rainProvider, weatherProvider } from './weather.ts'

const LayerId = z.enum(LAYER_IDS as [string, ...string[]])
const WORLD: Bbox = [-85, 85, -180, 180]

export interface LayerOptions {
  /** A fake AISStream socket in tests. */
  socket?: (url: string) => SocketLike
}

/** Every layer's provider, built once per plugin (each keeps its own short cache). */
export function createProviders(
  up: Upstream,
  options: LayerOptions = {},
): Record<string, Provider> {
  const providers: Record<string, Provider> = {
    flights: flightsProvider(up),
    vessels: vesselsProvider(up, options.socket === undefined ? {} : { socket: options.socket }),
    transit: transitProvider(up),
    receivers: receiversProvider(up),
    satellites: satellitesProvider(up),
    launches: launchesProvider(up),
    quakes: quakesProvider(up),
    events: eventsProvider(up),
    weather: weatherProvider(up),
    air: airProvider(up),
    rain: rainProvider(),
    cameras: camerasProvider(up),
    radio: radioProvider(up),
    imagery: imageryProvider(up),
  }
  for (const id of LAYER_IDS)
    if (providers[id] === undefined) throw new Error(`layer ${id} has no provider`)
  return providers
}

/** One layer's answer: a failing source becomes an `error` (the other layers still answer), a zoom too low a `note`. */
export async function answerLayer(
  providers: Record<string, Provider>,
  id: string,
  q: LayerQuery,
): Promise<LayerAnswer> {
  const info = layerOf(id)
  const provider = providers[id]
  if (info === undefined || provider === undefined)
    return { id, features: [], error: 'unknown layer', at: q.now }
  if (q.zoom < info.minZoom)
    return { id, features: [], note: `zoom in to ${info.minZoom} to see it`, at: q.now }
  try {
    const a = await provider.fetch(info.world === true ? { ...q, bbox: WORLD } : q)
    return {
      id,
      features: a.features,
      ...(a.raster === undefined ? {} : { raster: a.raster }),
      ...(a.note === undefined ? {} : { note: a.note.slice(0, 200) }),
      at: q.now,
    }
  } catch (error) {
    const message =
      error instanceof OperationError || (error instanceof Error && error.name === 'UpstreamError')
        ? failure(info.credit, error).message
        : error instanceof Error
          ? error.message
          : 'failed'
    return { id, features: [], error: message.slice(0, 200), at: q.now }
  }
}

const configOf = (raw: Readonly<Record<string, unknown>>) => {
  const parsed = MapsConfig.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/** The `layers` operation: what the map window draws for its view. Not offered to the model (`maps_explore` is). */
export function layersOperation(providers: Record<string, Provider>) {
  return defineOperation({
    name: 'layers',
    description:
      'The map window asks what its data layers show in its view: flights, ships, transit, satellites, quakes, weather, cameras, radio, imagery.',
    input: z.object({
      ids: z.array(LayerId).min(1).max(8),
      bbox: Bbox,
      zoom: z.number().min(0).max(22),
    }),
    output: z.object({ layers: z.array(LayerAnswer) }),
    permission: { capability: 'authenticated' },
    risk: 'read',
    source: 'outside',
    expose: { ai: false },
    rateLimit: { max: 90, windowMs: 60_000 },
    async run(input, k) {
      const q = {
        bbox: input.bbox,
        zoom: input.zoom,
        config: configOf(k.config),
        signal: k.signal,
        now: k.clock.now(),
      }
      const ids = [...new Set(input.ids)]
      return { layers: await Promise.all(ids.map((id) => answerLayer(providers, id, q))) }
    },
  })
}

/** A bbox around a point, `radiusKm` each way. */
export function bboxAround(lat: number, lon: number, radiusKm: number): Bbox {
  const dLat = radiusKm / 111.32
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  const wrap = (v: number) => ((v + 540) % 360) - 180
  return [
    Math.max(-90, lat - dLat),
    Math.min(90, lat + dLat),
    dLon >= 180 ? -180 : wrap(lon - dLon),
    dLon >= 180 ? 180 : wrap(lon + dLon),
  ]
}

/** The web map zoom that shows about `radiusKm` around the centre in a window. */
export const zoomForRadius = (radiusKm: number): number =>
  Math.max(0, Math.min(18, Math.round((Math.log2(40_075 / (2 * radiusKm)) + 1) * 10) / 10))

const Item = z.object({
  label: z.string(),
  kind: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  distanceKm: z.number().optional(),
  info: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  snapshot: z.boolean().optional(),
  playable: z.boolean().optional(),
})

const itemOf = (f: Feature, centre: { lat: number; lon: number }): z.infer<typeof Item> => ({
  label: f.label ?? f.id,
  ...(f.kind === undefined ? {} : { kind: f.kind }),
  lat: f.lat,
  lon: f.lon,
  distanceKm: Math.round(haversine([centre.lat, centre.lon], [f.lat, f.lon]) / 100) / 10,
  ...(f.info === undefined ? {} : { info: f.info }),
  ...(f.image === undefined ? {} : { snapshot: true }),
  ...(f.stream === undefined ? {} : { playable: true }),
})

/** The `explore` operation (`maps_explore`): a layer's things around a place, nearest first. */
export function exploreOperation(up: Upstream, providers: Record<string, Provider>) {
  return defineOperation({
    name: 'explore',
    description:
      'Read a live layer around a place, nearest first: flights, vessels (needs aisstreamKey), transit, receivers (own ADS-B), satellites, launches, quakes, events (fires, storms, volcanoes), weather, air, cameras (public cameras with snapshots), radio, imagery (Sentinel-2). near: a place name or { lat, lon }; radiusKm default 25. To show it, open maps:map with { lat, lon, zoom, layers: [layer] } using the zoom it returns.',
    input: z.object({
      layer: LayerId,
      near: Where,
      radiusKm: z.number().min(0.2).max(2_000).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    output: z.object({
      layer: z.string(),
      center: z.object({ name: z.string().optional(), lat: z.number(), lon: z.number() }),
      zoom: z.number(),
      total: z.number(),
      items: z.array(Item),
      note: z.string().optional(),
    }),
    permission: { capability: 'authenticated' },
    risk: 'read',
    // labels, names and descriptions come from public sources
    source: 'outside',
    rateLimit: { max: 20, windowMs: 60_000 },
    async run(input, k) {
      const centre = await resolvePlace(up, input.near, k.signal)
      const radiusKm = input.radiusKm ?? 25
      const info = layerOf(input.layer)
      // a city layer is asked at least at its own zoom, whatever the radius
      const zoom = Math.max(zoomForRadius(radiusKm), info?.minZoom ?? 0)
      const bbox = bboxAround(centre.lat, centre.lon, radiusKm)
      const answer = await answerLayer(providers, input.layer, {
        bbox,
        zoom,
        config: configOf(k.config),
        signal: k.signal,
        now: k.clock.now(),
      })
      if (answer.error !== undefined) throw new OperationError('CONFLICT', answer.error)
      const near = answer.features
        .map((f) => itemOf(f, centre))
        .filter((i) => (i.distanceKm ?? 0) <= radiusKm)
        .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
      const note =
        answer.raster !== undefined
          ? `${answer.note ?? ''} a map overlay: open the window to see it`.trim()
          : answer.note
      return {
        layer: input.layer,
        center: centre,
        zoom: Math.min(18, zoomForRadius(radiusKm)),
        total: near.length,
        items: near.slice(0, input.limit ?? 15),
        ...(note === undefined ? {} : { note }),
      }
    },
  })
}
