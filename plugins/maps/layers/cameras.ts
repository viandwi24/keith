// Public cameras: traffic cameras that their operators publish with a live snapshot (Transport for London JamCams, LTA Singapore,
// Hong Kong Transport Department, Fintraffic weather cameras), each list kept 10 minutes and asked only when the
// view overlaps its region; and, anywhere, cameras mapped in OpenStreetMap (`man_made=surveillance`, no picture) when zoomed in close.
// Snapshots reach the window through the core's net route as `../net/<host>/<path>`; their hosts are the window's `live` hosts.
import { OVERPASS, OVERPASS_MIRROR } from '../nearby.ts'
import { firstOf, type Upstream } from '../upstream.ts'
import { type Bbox, type Feature, finite, inBbox, netPath, type Provider, r5 } from './types.ts'

const LIST_MS = 10 * 60_000
const OSM_MS = 30 * 60_000
/** OpenStreetMap cameras only this close: a city-wide Overpass query is too heavy for a public instance. */
export const OSM_MIN_ZOOM = 13
const MAX_CAMERAS = 600

/** The hosts snapshots come from (the window's `network` and `live` lists). */
export const CAMERA_ORIGINS = [
  'https://s3-eu-west-1.amazonaws.com',
  'https://images.data.gov.sg',
  'https://tdcctv.data.one.gov.hk',
  'https://weathercam.digitraffic.fi',
]

interface Source {
  id: string
  /** `[south, north, west, east]` the cameras are in. */
  region: Bbox
  credit: string
  load(up: Upstream, signal: AbortSignal): Promise<Feature[]>
}

const camera = (
  source: string,
  id: string,
  lat: number,
  lon: number,
  name: string,
  imageUrl: string | undefined,
  extra: Record<string, string> = {},
): Feature | undefined => {
  const image = imageUrl === undefined ? undefined : netPath(imageUrl)
  if (!finite(lat) || !finite(lon) || image === undefined) return undefined
  return {
    id: `cam:${source}:${id}`.slice(0, 80),
    lat: r5(lat),
    lon: r5(lon),
    label: name.slice(0, 80),
    kind: 'traffic camera',
    image,
    info: { Camera: name.slice(0, 200), ...extra, Source: source },
  }
}

export function tflCameras(body: unknown): Feature[] {
  if (!Array.isArray(body)) return []
  const out: Feature[] = []
  for (const raw of body) {
    const c = raw as Record<string, unknown>
    const props = Array.isArray(c.additionalProperties)
      ? (c.additionalProperties as { key?: unknown; value?: unknown }[])
      : []
    const prop = (k: string) => props.find((p) => p.key === k)?.value
    if (prop('available') === 'false') continue
    const url = prop('imageUrl')
    const f = camera(
      'TfL',
      String(c.id ?? out.length),
      Number(c.lat),
      Number(c.lon),
      String(c.commonName ?? 'JamCam'),
      typeof url === 'string' ? url : undefined,
    )
    if (f !== undefined) out.push(f)
  }
  return out
}

export function singaporeCameras(body: unknown): Feature[] {
  const items = (body as { items?: { cameras?: unknown }[] })?.items
  const list = Array.isArray(items) ? items[0]?.cameras : undefined
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const c = raw as Record<string, unknown>
    const at = (c.location ?? {}) as Record<string, unknown>
    const f = camera(
      'LTA Singapore',
      String(c.camera_id ?? out.length),
      Number(at.latitude),
      Number(at.longitude),
      `Camera ${String(c.camera_id ?? '')}`.trim(),
      typeof c.image === 'string' ? c.image : undefined,
      typeof c.timestamp === 'string' ? { Taken: c.timestamp } : {},
    )
    if (f !== undefined) out.push(f)
  }
  return out
}

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([^<]{0,300})</${name}>`).exec(xml)
  return m?.[1]?.trim()
}

/** Hong Kong's camera list is XML: one `<image>` per camera. */
export function hongKongCameras(xml: string): Feature[] {
  const out: Feature[] = []
  for (const m of xml.matchAll(/<image>([\s\S]{0,2000}?)<\/image>/g)) {
    const block = m[1] ?? ''
    const key = tag(block, 'key') ?? String(out.length)
    const district = tag(block, 'district')
    const f = camera(
      'HK Transport Department',
      key,
      Number(tag(block, 'latitude')),
      Number(tag(block, 'longitude')),
      decode(tag(block, 'description') ?? key),
      tag(block, 'url'),
      district === undefined ? {} : { District: decode(district) },
    )
    if (f !== undefined) out.push(f)
  }
  return out
}

const decode = (s: string) =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")

/** Fintraffic weather cameras: one feature per station, its first collected preset as the picture. */
export function finlandCameras(body: unknown): Feature[] {
  const list = (body as { features?: unknown })?.features
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const s = raw as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }
    const c = s.geometry?.coordinates
    const p = s.properties ?? {}
    if (!Array.isArray(c) || p.collectionStatus !== 'GATHERING') continue
    const presets = Array.isArray(p.presets)
      ? (p.presets as { id?: unknown; inCollection?: unknown }[])
      : []
    const preset = presets.find((x) => x.inCollection === true && typeof x.id === 'string')
    if (preset === undefined) continue
    const f = camera(
      'Fintraffic',
      String(p.id ?? out.length),
      Number(c[1]),
      Number(c[0]),
      String(p.name ?? p.id ?? 'Weather camera').replaceAll('_', ' '),
      `https://weathercam.digitraffic.fi/${String(preset.id)}.jpg`,
    )
    if (f !== undefined) out.push({ ...f, kind: 'weather camera' })
  }
  return out
}

export const SOURCES: Source[] = [
  {
    id: 'tfl',
    region: [51.2, 51.8, -0.6, 0.4],
    credit: 'Transport for London',
    load: async (up, signal) =>
      tflCameras(
        await up.json('https://api.tfl.gov.uk/Place/Type/JamCam', { signal, timeoutMs: 20_000 }),
      ),
  },
  {
    id: 'sg',
    region: [1.15, 1.5, 103.6, 104.1],
    credit: 'LTA Singapore',
    load: async (up, signal) =>
      singaporeCameras(
        await up.json('https://api.data.gov.sg/v1/transport/traffic-images', {
          signal,
          timeoutMs: 15_000,
        }),
      ),
  },
  {
    id: 'hk',
    region: [22.1, 22.6, 113.8, 114.5],
    credit: 'HK Transport Department',
    load: async (up, signal) =>
      hongKongCameras(
        await up.text(
          'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml',
          { signal, timeoutMs: 15_000 },
        ),
      ),
  },
  {
    id: 'fi',
    region: [59.5, 70.2, 19, 31.6],
    credit: 'Fintraffic',
    load: async (up, signal) =>
      finlandCameras(
        await up.json('https://tie.digitraffic.fi/api/weathercam/v1/stations', {
          signal,
          timeoutMs: 20_000,
        }),
      ),
  },
]

/** Whether two bboxes overlap (the second may cross the antimeridian; regions never do). */
export function overlaps(region: Bbox, view: Bbox): boolean {
  const [s, n, w, e] = region
  const [vs, vn, vw, ve] = view
  if (vn < s || vs > n) return false
  if (vw <= ve) return !(ve < w || vw > e)
  return e >= vw || w <= ve
}

/** OpenStreetMap's mapped cameras in a bbox: no picture, but what is known (type, zone, operator). */
export function osmCameras(body: unknown): Feature[] {
  const list = (body as { elements?: unknown })?.elements
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const e = raw as { id?: unknown; lat?: unknown; lon?: unknown; tags?: Record<string, unknown> }
    if (!finite(e.lat) || !finite(e.lon)) continue
    const t = e.tags ?? {}
    const s = (k: string) => (typeof t[k] === 'string' ? (t[k] as string).slice(0, 120) : undefined)
    const type = s('camera:type') ?? s('surveillance:type') ?? 'camera'
    const info: Record<string, string> = {}
    for (const [k, label] of [
      ['surveillance', 'Watches'],
      ['surveillance:zone', 'Zone'],
      ['camera:type', 'Type'],
      ['camera:direction', 'Facing'],
      ['operator', 'Operator'],
      ['description', 'About'],
    ] as const) {
      const v = s(k)
      if (v !== undefined) info[label] = v
    }
    info.Source = 'OpenStreetMap'
    out.push({
      id: `osmcam:${String(e.id ?? out.length)}`,
      lat: r5(e.lat),
      lon: r5(e.lon),
      label: s('name') ?? `${type} camera`,
      kind: 'mapped camera',
      info,
    })
    if (out.length >= MAX_CAMERAS) break
  }
  return out
}

export function osmCameraQuery(b: Bbox): string {
  const [s, n, w, e] = b.map((v) => v.toFixed(5))
  return `[out:json][timeout:15];node["man_made"="surveillance"](${s},${w},${n},${e});out ${MAX_CAMERAS};`
}

export function camerasProvider(up: Upstream): Provider {
  const lists = new Map<string, { at: number; features: Feature[] }>()
  const osm = new Map<string, { at: number; features: Feature[] }>()

  async function listOf(src: Source, signal: AbortSignal, now: number): Promise<Feature[]> {
    const hit = lists.get(src.id)
    if (hit !== undefined && now - hit.at < LIST_MS) return hit.features
    try {
      const features = await src.load(up, signal)
      lists.set(src.id, { at: now, features })
      return features
    } catch (error) {
      if (hit !== undefined) return hit.features
      throw error
    }
  }

  async function mapped(b: Bbox, signal: AbortSignal, now: number): Promise<Feature[]> {
    // snapped to 0.01° so a small pan reuses the answer
    const snap: Bbox = [
      Math.floor(b[0] * 100) / 100,
      Math.ceil(b[1] * 100) / 100,
      Math.floor(b[2] * 100) / 100,
      Math.ceil(b[3] * 100) / 100,
    ]
    const key = snap.join(',')
    const hit = osm.get(key)
    if (hit !== undefined && now - hit.at < OSM_MS) return hit.features
    const body = {
      text: `data=${encodeURIComponent(osmCameraQuery(snap))}`,
      type: 'application/x-www-form-urlencoded',
    }
    const answer = await firstOf('OpenStreetMap', [
      () => up.json(OVERPASS, { signal, timeoutMs: 15_000, body }),
      () => up.json(OVERPASS_MIRROR, { signal, timeoutMs: 15_000, body }),
    ])
    const features = osmCameras(answer)
    if (osm.size > 32) osm.clear()
    osm.set(key, { at: now, features })
    return features
  }

  return {
    async fetch(q) {
      const features: Feature[] = []
      const failed: string[] = []
      for (const src of SOURCES) {
        if (!overlaps(src.region, q.bbox)) continue
        try {
          for (const f of await listOf(src, q.signal, q.now))
            if (inBbox(q.bbox, f.lat, f.lon) && features.length < MAX_CAMERAS) features.push(f)
        } catch {
          failed.push(src.credit)
        }
      }
      let note: string | undefined
      if (q.zoom >= OSM_MIN_ZOOM) {
        try {
          features.push(...(await mapped(q.bbox, q.signal, q.now)))
        } catch {
          failed.push('OpenStreetMap')
        }
      } else note = `zoom in to ${OSM_MIN_ZOOM} for cameras mapped in OpenStreetMap`
      if (failed.length > 0) note = `${failed.join(', ')} did not answer`
      return note === undefined ? { features } : { features, note }
    },
  }
}
