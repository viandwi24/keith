// Recent imagery: the latest clear Sentinel-2 scene of each 100 km tile in the view, from Element 84's Earth Search STAC catalogue
// (Copernicus data, free), draped on the map as its true-colour preview through the core's net route. A preview is a few hundred
// pixels for 100 km: enough to see clouds, smoke, floods and burn scars, not cars.
import type { Upstream } from '../upstream.ts'
import { type Bbox, type Feature, finite, netPath, type Provider, r5 } from './types.ts'

export const EARTH_SEARCH = 'https://earth-search.aws.element84.com'
export const IMAGERY_ORIGINS = ['https://sentinel-cogs.s3.us-west-2.amazonaws.com']
const DAYS = 45
const MAX_CLOUD = 40
const MAX_SCENES = 8
const IMAGERY_MS = 60 * 60_000

/** The STAC search: newest first over the last `DAYS` days. Cloud cover is filtered here (the catalogue's `query` is not offered). */
export function searchBody(b: Bbox, now: number): string {
  const [s, n, w, e] = b
  const from = new Date(now - DAYS * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(now).toISOString().slice(0, 10)
  return JSON.stringify({
    collections: ['sentinel-2-l2a'],
    // a view across the antimeridian asks for its western part only
    bbox: [w, s, w <= e ? e : 180, n],
    datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
    limit: 100,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  })
}

/** The newest clear scene of each tile (`S2A_48MXU_20261116_0_L2A` → tile `48MXU`). */
export function sceneFeatures(body: unknown): Feature[] {
  const list = (body as { features?: unknown })?.features
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: Feature[] = []
  for (const raw of list) {
    const f = raw as {
      id?: unknown
      bbox?: unknown
      properties?: Record<string, unknown>
      assets?: Record<string, { href?: unknown }>
    }
    const id = typeof f.id === 'string' ? f.id : ''
    const tile = id.split('_')[1] ?? id
    const cloud = f.properties?.['eo:cloud_cover']
    const href = f.assets?.thumbnail?.href
    const image = typeof href === 'string' ? netPath(href) : undefined
    const bb = f.bbox
    if (tile === '' || seen.has(tile) || image === undefined) continue
    if (!finite(cloud) || cloud > MAX_CLOUD) continue
    if (!Array.isArray(bb) || bb.length !== 4 || !bb.every(finite)) continue
    const [w, s, e, n] = bb as number[] as [number, number, number, number]
    // a tile across the antimeridian has a bbox the map cannot drape
    if (e < w || e - w > 5) continue
    seen.add(tile)
    const when = typeof f.properties?.datetime === 'string' ? f.properties.datetime : ''
    out.push({
      id: `s2:${id}`.slice(0, 80),
      lat: r5((s + n) / 2),
      lon: r5((w + e) / 2),
      label: when.slice(0, 10),
      kind: 'Sentinel-2 scene',
      image,
      rect: [r5(s), r5(n), r5(w), r5(e)],
      ...(when === '' ? {} : { at: Date.parse(when) }),
      info: {
        Scene: id.slice(0, 120),
        Taken: when.replace('T', ' ').slice(0, 16) + ' UTC',
        Clouds: `${Math.round(cloud)}%`,
        Tile: tile,
        Source: 'Copernicus Sentinel-2 (Earth Search)',
      },
    })
    if (out.length >= MAX_SCENES) break
  }
  return out
}

export function imageryProvider(up: Upstream): Provider {
  const kept = new Map<string, { at: number; features: Feature[] }>()
  return {
    async fetch(q) {
      // snapped to 0.1° so a small pan reuses the answer
      const snap: Bbox = [
        Math.floor(q.bbox[0] * 10) / 10,
        Math.ceil(q.bbox[1] * 10) / 10,
        Math.floor(q.bbox[2] * 10) / 10,
        Math.ceil(q.bbox[3] * 10) / 10,
      ]
      const key = snap.join(',')
      const hit = kept.get(key)
      if (hit !== undefined && q.now - hit.at < IMAGERY_MS) return { features: hit.features }
      const body = await up.json(`${EARTH_SEARCH}/v1/search`, {
        signal: q.signal,
        timeoutMs: 20_000,
        body: { text: searchBody(snap, q.now), type: 'application/json' },
      })
      const features = sceneFeatures(body)
      if (kept.size > 32) kept.clear()
      kept.set(key, { at: q.now, features })
      return features.length === 0
        ? { features, note: `no scene under ${MAX_CLOUD}% cloud in the last ${DAYS} days` }
        : { features }
    },
  }
}
