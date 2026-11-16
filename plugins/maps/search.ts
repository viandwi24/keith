import { defineOperation } from '@keith/host'
import { z } from '@keith/host/schema'
import { firstOf, type Upstream, UpstreamError } from './upstream.ts'

/** OpenStreetMap Nominatim, the free geocoder (usage policy: a real User-Agent, at most about one request a second). */
export const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
/** Photon (komoot), the fallback geocoder: tolerant of typos; its public instance is for light use, about one request a second. */
export const PHOTON = 'https://photon.komoot.io/api/'
export const SEARCH_TIMEOUT_MS = 5_000
const NAME_MAX = 200

export const SearchInput = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(5).optional(),
})

const Place = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  /** `[south, north, west, east]`, as Nominatim gives it. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  kind: z.string().optional(),
})
export const SearchOutput = z.object({
  results: z.array(Place),
  /** Which geocoder answered. */
  source: z.enum(['nominatim', 'photon']).optional(),
})
export type Place = z.infer<typeof Place>

/** One Nominatim row (format `jsonv2`): numbers come as strings. */
const Row = z.object({
  display_name: z.string().optional(),
  name: z.string().optional(),
  lat: z.union([z.string(), z.number()]),
  lon: z.union([z.string(), z.number()]),
  boundingbox: z.array(z.union([z.string(), z.number()])).optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  addresstype: z.string().optional(),
})

/** One Photon feature (GeoJSON). */
const Feature = z.object({
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z
    .object({
      name: z.string().optional(),
      street: z.string().optional(),
      housenumber: z.string().optional(),
      district: z.string().optional(),
      city: z.string().optional(),
      county: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      osm_value: z.string().optional(),
      type: z.string().optional(),
      /** `[west, north, east, south]`. */
      extent: z.array(z.number()).optional(),
    })
    .default({}),
})

const finite = (v: string | number): number | undefined => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}
const inRange = (lat: number, lon: number) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180

/** Maps Nominatim's answer to places; rows without a usable position are dropped. */
export function toPlaces(body: unknown, limit: number): Place[] {
  if (!Array.isArray(body)) throw new UpstreamError('unreadable')
  const places: Place[] = []
  for (const raw of body) {
    const row = Row.safeParse(raw)
    if (!row.success) continue
    const lat = finite(row.data.lat)
    const lon = finite(row.data.lon)
    if (lat === undefined || lon === undefined || !inRange(lat, lon)) continue
    const name = (row.data.display_name ?? row.data.name ?? '').trim().slice(0, NAME_MAX)
    if (name === '') continue
    const place: Place = { name, lat, lon }
    const box = row.data.boundingbox?.map(finite)
    if (box?.length === 4 && box.every((n) => n !== undefined)) {
      place.bbox = box as [number, number, number, number]
    }
    const kind = row.data.addresstype ?? row.data.type
    if (kind !== undefined && kind !== '') place.kind = kind.slice(0, 40)
    places.push(place)
    if (places.length >= limit) break
  }
  return places
}

/** Maps Photon's answer to places: the name joins the name, street and the areas around it, without repeats. */
export function photonPlaces(body: unknown, limit: number): Place[] {
  const features = (body as { features?: unknown } | null)?.features
  if (!Array.isArray(features)) throw new UpstreamError('unreadable')
  const places: Place[] = []
  for (const raw of features) {
    const f = Feature.safeParse(raw)
    if (!f.success) continue
    const [lon, lat] = f.data.geometry.coordinates
    if (!inRange(lat, lon)) continue
    const p = f.data.properties
    const street = [p.street, p.housenumber].filter(Boolean).join(' ')
    const parts: string[] = []
    for (const part of [p.name, street, p.district, p.city, p.county, p.state, p.country]) {
      const t = part?.trim()
      if (t && !parts.includes(t)) parts.push(t)
    }
    const name = parts.join(', ').slice(0, NAME_MAX)
    if (name === '') continue
    const place: Place = { name, lat, lon }
    const e = p.extent
    if (e?.length === 4) place.bbox = [e[3] ?? 0, e[1] ?? 0, e[0] ?? 0, e[2] ?? 0]
    const kind = p.osm_value ?? p.type
    if (kind !== undefined && kind !== '') place.kind = kind.slice(0, 40)
    places.push(place)
    if (places.length >= limit) break
  }
  return places
}

export interface Geocoded {
  results: Place[]
  source: 'nominatim' | 'photon'
}

/** Nominatim first; Photon when Nominatim fails or finds nothing. */
export function geocode(
  up: Upstream,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Geocoded> {
  const q = encodeURIComponent(query)
  return firstOf<Geocoded>(
    'the map search',
    [
      async () => ({
        source: 'nominatim',
        results: toPlaces(
          await up.json(`${NOMINATIM}?format=jsonv2&q=${q}&limit=${limit}`, {
            signal,
            timeoutMs: SEARCH_TIMEOUT_MS,
          }),
          limit,
        ),
      }),
      async () => ({
        source: 'photon',
        results: photonPlaces(
          await up.json(`${PHOTON}?q=${q}&limit=${limit}`, {
            signal,
            timeoutMs: SEARCH_TIMEOUT_MS,
          }),
          limit,
        ),
      }),
    ],
    (found) => found.results.length > 0,
  )
}

/** The `search` operation (`maps_search`). */
export function searchOperation(up: Upstream) {
  return defineOperation({
    name: 'search',
    description:
      'Find a place on OpenStreetMap by name or address (a city, a street, a landmark). Returns its name, latitude, longitude and bounding box; open the map window with them to show it.',
    input: SearchInput,
    output: SearchOutput,
    permission: { capability: 'authenticated' },
    risk: 'read',
    // the names come from OpenStreetMap: anyone on the internet can have written them
    source: 'outside',
    rateLimit: { max: 30, windowMs: 60_000 },
    async run(input, k) {
      return geocode(up, input.query, input.limit ?? 5, k.signal)
    },
  })
}
