import { defineOperation } from '@keith/host'
import { z } from '@keith/host/schema'
import { haversine } from './geo.ts'
import { resolvePlace, Where } from './route.ts'
import { firstOf, type Upstream, UpstreamError } from './upstream.ts'

/** The main Overpass API instance, and a public mirror as the last fallback. */
export const OVERPASS = 'https://overpass-api.de/api/interpreter'
export const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter'
/** Short: on some networks Overpass hosts never answer, and Photon is the next try. */
const OVERPASS_TIMEOUT_MS = 8_000
/** Photon's reverse search with tag filters: nearest places of a kind, without opening hours. */
export const PHOTON_REVERSE = 'https://photon.komoot.io/reverse'

/** Each kind of place as Overpass tag filters (any of them matches). Fixed text: nothing from the input reaches the query here. */
export const CATEGORIES = {
  pharmacy: ['["amenity"="pharmacy"]'],
  hospital: ['["amenity"="hospital"]'],
  clinic: ['["amenity"~"^(clinic|doctors)$"]'],
  atm: ['["amenity"="atm"]', '["atm"="yes"]'],
  bank: ['["amenity"="bank"]'],
  fuel: ['["amenity"="fuel"]'],
  ev_charging: ['["amenity"="charging_station"]'],
  restaurant: ['["amenity"="restaurant"]'],
  cafe: ['["amenity"="cafe"]'],
  fast_food: ['["amenity"="fast_food"]'],
  supermarket: ['["shop"="supermarket"]'],
  convenience: ['["shop"="convenience"]'],
  mall: ['["shop"="mall"]'],
  market: ['["amenity"="marketplace"]'],
  mosque: ['["amenity"="place_of_worship"]["religion"="muslim"]'],
  church: ['["amenity"="place_of_worship"]["religion"="christian"]'],
  place_of_worship: ['["amenity"="place_of_worship"]'],
  hotel: ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]'],
  parking: ['["amenity"="parking"]'],
  police: ['["amenity"="police"]'],
  school: ['["amenity"="school"]'],
  university: ['["amenity"="university"]'],
  toilets: ['["amenity"="toilets"]'],
  bus_stop: ['["highway"="bus_stop"]'],
  train_station: ['["railway"="station"]'],
  park: ['["leisure"="park"]'],
  attraction: ['["tourism"~"^(attraction|museum|viewpoint)$"]'],
} as const
export type Category = keyof typeof CATEGORIES
const CATEGORY_NAMES = Object.keys(CATEGORIES) as [Category, ...Category[]]

/** The same kinds as Photon `osm_tag` filters (`key:value`, any of them). A mosque or a church is any place of worship there. */
export const PHOTON_TAGS: Record<Category, readonly string[]> = {
  pharmacy: ['amenity:pharmacy'],
  hospital: ['amenity:hospital'],
  clinic: ['amenity:clinic', 'amenity:doctors'],
  atm: ['amenity:atm'],
  bank: ['amenity:bank'],
  fuel: ['amenity:fuel'],
  ev_charging: ['amenity:charging_station'],
  restaurant: ['amenity:restaurant'],
  cafe: ['amenity:cafe'],
  fast_food: ['amenity:fast_food'],
  supermarket: ['shop:supermarket'],
  convenience: ['shop:convenience'],
  mall: ['shop:mall'],
  market: ['amenity:marketplace'],
  mosque: ['amenity:place_of_worship'],
  church: ['amenity:place_of_worship'],
  place_of_worship: ['amenity:place_of_worship'],
  hotel: ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel', 'tourism:motel'],
  parking: ['amenity:parking'],
  police: ['amenity:police'],
  school: ['amenity:school'],
  university: ['amenity:university'],
  toilets: ['amenity:toilets'],
  bus_stop: ['highway:bus_stop'],
  train_station: ['railway:station'],
  park: ['leisure:park'],
  attraction: ['tourism:attraction', 'tourism:museum', 'tourism:viewpoint'],
}

/** An OpenStreetMap tag: a plain key and an optional plain value; the patterns keep quotes and brackets out of the query. */
const Tag = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_:]{0,39}$/),
  value: z
    .string()
    .regex(/^[A-Za-z0-9_ :;.-]{1,60}$/)
    .optional(),
})

export const NearbyInput = z
  .object({
    near: Where,
    kind: z.enum(CATEGORY_NAMES).optional(),
    /** Any other OpenStreetMap tag (for example `{ key: 'cuisine', value: 'padang' }`). */
    tag: Tag.optional(),
    radius: z.number().int().min(50).max(5_000).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine((v) => v.kind !== undefined || v.tag !== undefined, {
    message: 'give a kind or a tag',
  })

const Found = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  kind: z.string().optional(),
  distanceM: z.number(),
  address: z.string().optional(),
  openingHours: z.string().optional(),
})
type Found = z.infer<typeof Found>
export const NearbyOutput = z.object({
  center: z.object({ name: z.string().optional(), lat: z.number(), lon: z.number() }),
  results: z.array(Found),
  /** Which service answered: Photon gives no opening hours. */
  source: z.enum(['overpass', 'photon']),
})

const PhotonPoi = z.object({
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z
    .object({
      name: z.string().optional(),
      osm_value: z.string().optional(),
      street: z.string().optional(),
      housenumber: z.string().optional(),
    })
    .default({}),
})

/** Photon's reverse answer to places, nearest first. */
export function photonFound(body: unknown, lat: number, lon: number, limit: number): Found[] {
  const features = (body as { features?: unknown } | null)?.features
  if (!Array.isArray(features)) throw new UpstreamError('unreadable')
  const out: Found[] = []
  for (const raw of features) {
    const f = PhotonPoi.safeParse(raw)
    if (!f.success) continue
    const [plon, plat] = f.data.geometry.coordinates
    const p = f.data.properties
    const kind = p.osm_value?.slice(0, 40)
    const found: Found = {
      name: (p.name ?? kind ?? 'unnamed').trim().slice(0, 120),
      lat: plat,
      lon: plon,
      distanceM: Math.round(haversine([lat, lon], [plat, plon])),
    }
    if (kind !== undefined) found.kind = kind
    const address = [p.street, p.housenumber].filter(Boolean).join(' ').trim()
    if (address !== '') found.address = address.slice(0, 120)
    out.push(found)
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit)
}

/** The Photon reverse URL: radius in km, every tag as one `osm_tag`. */
export function photonNearbyUrl(
  tags: readonly string[],
  lat: number,
  lon: number,
  radius: number,
  limit: number,
): string {
  const q = tags.map((t) => `&osm_tag=${encodeURIComponent(t)}`).join('')
  return `${PHOTON_REVERSE}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&radius=${radius / 1_000}&limit=${limit}${q}`
}

const Element = z.object({
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).default({}),
})

/** The Overpass QL query: every filter around the point, at most `max` elements with their centre and tags. */
export function overpassQuery(
  filters: readonly string[],
  lat: number,
  lon: number,
  radius: number,
  max: number,
): string {
  const around = `(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})`
  return `[out:json][timeout:15];(${filters.map((f) => `nwr${f}${around};`).join('')});out center tags ${max};`
}

export function tagFilter(tag: z.infer<typeof Tag>): string {
  return tag.value === undefined ? `["${tag.key}"]` : `["${tag.key}"="${tag.value}"]`
}

const KIND_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'railway', 'highway', 'healthcare']

/** Elements to places, nearest first; unnamed ones keep their kind as the name. */
export function toFound(body: unknown, lat: number, lon: number, limit: number): Found[] {
  const elements = (body as { elements?: unknown } | null)?.elements
  if (!Array.isArray(elements)) throw new UpstreamError('unreadable')
  const out: Found[] = []
  for (const raw of elements) {
    const e = Element.safeParse(raw)
    if (!e.success) continue
    const at = e.data.center ?? (e.data.lat !== undefined ? e.data : undefined)
    if (at?.lat === undefined || at.lon === undefined) continue
    const t = e.data.tags
    const kindKey = KIND_KEYS.find((k) => t[k] !== undefined)
    const kind = kindKey === undefined ? undefined : t[kindKey]?.slice(0, 40)
    const name = (t.name ?? t.brand ?? kind ?? 'unnamed').trim().slice(0, 120)
    const found: Found = {
      name,
      lat: at.lat,
      lon: at.lon,
      distanceM: Math.round(haversine([lat, lon], [at.lat, at.lon])),
    }
    if (kind !== undefined) found.kind = kind
    const address = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ').trim()
    if (address !== '') found.address = address.slice(0, 120)
    if (t.opening_hours !== undefined) found.openingHours = t.opening_hours.slice(0, 80)
    out.push(found)
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit)
}

/** The `nearby` operation (`maps_nearby`). */
export function nearbyOperation(up: Upstream) {
  return defineOperation({
    name: 'nearby',
    description:
      'Find places of one kind near a place name or position, nearest first, from OpenStreetMap: a kind from the list (pharmacy, atm, fuel, cafe, mosque, hotel…) or any OpenStreetMap tag { key, value? }. radius in metres (default 1000, at most 5000). To show them, open the map window with params { lat, lon, places: [{ lat, lon, label }] }.',
    input: NearbyInput,
    output: NearbyOutput,
    permission: { capability: 'authenticated' },
    risk: 'read',
    // names and opening hours come from OpenStreetMap
    source: 'outside',
    rateLimit: { max: 20, windowMs: 60_000 },
    async run(input, k) {
      const center = await resolvePlace(up, input.near, k.signal)
      const filters = [
        ...(input.kind === undefined ? [] : CATEGORIES[input.kind]),
        ...(input.tag === undefined ? [] : [tagFilter(input.tag)]),
      ]
      const limit = input.limit ?? 10
      const radius = input.radius ?? 1_000
      const query = overpassQuery(filters, center.lat, center.lon, radius, 100)
      const body = {
        text: `data=${encodeURIComponent(query)}`,
        type: 'application/x-www-form-urlencoded',
      }
      const ask = (url: string) => async () => ({
        source: 'overpass' as const,
        results: toFound(
          await up.json(url, { signal: k.signal, timeoutMs: OVERPASS_TIMEOUT_MS, body }),
          center.lat,
          center.lon,
          limit,
        ),
      })
      const photonTags = [
        ...(input.kind === undefined ? [] : PHOTON_TAGS[input.kind]),
        ...(input.tag === undefined
          ? []
          : [
              input.tag.value === undefined ? input.tag.key : `${input.tag.key}:${input.tag.value}`,
            ]),
      ]
      const photon = async () => ({
        source: 'photon' as const,
        results: photonFound(
          await up.json(photonNearbyUrl(photonTags, center.lat, center.lon, radius, limit), {
            signal: k.signal,
          }),
          center.lat,
          center.lon,
          limit,
        ),
      })
      // Overpass first (opening hours, exact filters); Photon when it cannot be reached; then the Overpass mirror
      const found = await firstOf<{ source: 'overpass' | 'photon'; results: Found[] }>(
        'the place search',
        [ask(OVERPASS), photon, ask(OVERPASS_MIRROR)],
      )
      return { center, ...found }
    },
  })
}
