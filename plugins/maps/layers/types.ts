// What a data layer answers (docs/specs/plugins/maps.md "Data layers"): features the map window draws and the agent reads, from a
// provider that fetches one public source. Shared by every provider and the `layers` and `explore` operations.
import { z } from '@keith/host/schema'
import type { Upstream } from '../upstream.ts'

export const Bbox = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
])
/** `[south, north, west, east]`; west may be greater than east when the view crosses the antimeridian. */
export type Bbox = z.infer<typeof Bbox>

const Info = z.record(z.string().max(40), z.union([z.string().max(200), z.number()]))

/** One thing on the map: a point with facts, maybe moving, maybe with a line, a track or an image. */
export const Feature = z.object({
  id: z.string().max(80),
  lat: z.number(),
  lon: z.number(),
  /** Metres above the ellipsoid (an aircraft, a satellite). */
  alt: z.number().optional(),
  /** Degrees from north. */
  heading: z.number().optional(),
  /** Metres a second (the map moves it on between answers). */
  speed: z.number().optional(),
  label: z.string().max(80).optional(),
  kind: z.string().max(40).optional(),
  /** How strong (a quake's magnitude). */
  size: z.number().optional(),
  /** The reading the icon is coloured by (a temperature, an AQI). */
  value: z.number().optional(),
  info: Info.optional(),
  /** An image through the core's net route, relative to the map page (`../net/<host>/<path>`). */
  image: z.string().max(600).optional(),
  /** An https audio stream (a radio station). */
  stream: z.string().max(600).optional(),
  /** A line drawn with it (a track behind it, a storm's path). */
  line: z
    .array(z.tuple([z.number(), z.number()]))
    .max(400)
    .optional(),
  /** Samples `[t ms, lat, lon, alt m]` the map follows (a satellite's next minutes). */
  track: z
    .array(z.tuple([z.number(), z.number(), z.number(), z.number()]))
    .max(64)
    .optional(),
  /** `[south, north, west, east]` an image is draped over (a satellite scene). */
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** When the fix was taken, ms since 1970. */
  at: z.number().optional(),
})
export type Feature = z.infer<typeof Feature>

export const Raster = z.object({
  /** A tile template through the core's net route (`../net/<host>/…/{z}/{x}/{y}.png`). */
  template: z.string().max(400),
  maxZoom: z.number().int().min(0).max(22),
  alpha: z.number().min(0).max(1).optional(),
})

export const LayerAnswer = z.object({
  id: z.string(),
  features: z.array(Feature),
  raster: Raster.optional(),
  /** Why it is empty or partial ("needs the aisstreamKey setting", "zoom in"). */
  note: z.string().max(200).optional(),
  /** The source failed; the other layers still answer. */
  error: z.string().max(200).optional(),
  /** When this answer was made. */
  at: z.number(),
})
export type LayerAnswer = z.infer<typeof LayerAnswer>

/** The maps plugin's settings (`KEITH_PLUGIN_CONFIG` `{ "maps": { … } }`). */
export const MapsConfig = z.object({
  /** An AISStream.io API key: turns the Ships layer on. */
  aisstreamKey: z.string().min(8).max(200).optional(),
  /** Your own receivers: readsb / dump1090 `aircraft.json` URLs on your network (http or https). */
  receivers: z.array(z.string().url().max(300)).max(8).optional(),
})
export type MapsConfig = z.infer<typeof MapsConfig>

/** What a provider is asked: the view, its zoom, the plugin's settings, and the request's signal. */
export interface LayerQuery {
  bbox: Bbox
  zoom: number
  config: MapsConfig
  signal: AbortSignal
  now: number
}

/** The answer of one provider, before the operation stamps its id and time. */
export interface ProviderAnswer {
  features: Feature[]
  raster?: z.infer<typeof Raster>
  note?: string
}

export interface Provider {
  /** Answers for a view; throws an `UpstreamError` or an `OperationError` when its source fails. */
  fetch(q: LayerQuery): Promise<ProviderAnswer>
}

export type ProviderFactory = (up: Upstream) => Provider

/** Whether a point is inside a bbox (across the antimeridian too). */
export function inBbox(b: Bbox, lat: number, lon: number): boolean {
  const [s, n, w, e] = b
  if (lat < s || lat > n) return false
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e
}

/** The centre of a bbox and the distance from it to a corner, in metres. */
export function centreOf(b: Bbox): { lat: number; lon: number; radiusM: number } {
  const [s, n, w, e] = b
  const span = w <= e ? e - w : e + 360 - w
  const lon = ((w + span / 2 + 540) % 360) - 180
  const lat = (s + n) / 2
  const dLat = ((n - s) / 2) * 111_320
  const dLon = (span / 2) * 111_320 * Math.cos((lat * Math.PI) / 180)
  return { lat, lon, radiusM: Math.hypot(dLat, dLon) }
}

/** A path relative to the map page through the core's net route: `https://host/a/b.jpg` → `../net/host/a/b.jpg`. */
export function netPath(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.search !== '') return undefined
    if (!/^[A-Za-z0-9._~@=,+\-/]{1,512}$/.test(u.pathname.slice(1))) return undefined
    return `../net/${u.host}${u.pathname}`
  } catch {
    return undefined
  }
}

/** Rounds a coordinate to 5 decimals (about a metre). */
export const r5 = (v: number): number => Math.round(v * 1e5) / 1e5

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
