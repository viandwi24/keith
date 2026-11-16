// Radio: internet radio stations around the view from the Radio Browser community directory (public domain data), most listened
// first, with their https stream so the window can play them (`media-src https:`). Plain-http and HLS streams are left out: a page in
// the core cannot play them.
import { firstOf, type Upstream } from '../upstream.ts'
import { centreOf, type Feature, finite, inBbox, type Provider, r5 } from './types.ts'

export const RADIO_HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
]
const RADIO_MS = 60 * 60_000
const MAX_STATIONS = 200
const MAX_RADIUS_M = 1_500_000

export function stationFeatures(body: unknown): Feature[] {
  if (!Array.isArray(body)) return []
  const out: Feature[] = []
  const seen = new Set<string>()
  for (const raw of body) {
    const s = raw as Record<string, unknown>
    const stream = typeof s.url_resolved === 'string' ? s.url_resolved : ''
    if (!finite(s.geo_lat) || !finite(s.geo_long) || !stream.startsWith('https://')) continue
    if (s.hls === 1 || stream.length > 600 || s.lastcheckok === 0) continue
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 80) : 'Station'
    // the directory has many copies of one station
    const key = `${name.toLowerCase()}|${stream}`
    if (seen.has(key)) continue
    seen.add(key)
    const info: Record<string, string | number> = { Station: name }
    if (typeof s.tags === 'string' && s.tags !== '') info.Genre = s.tags.slice(0, 120)
    const where = [s.state, s.country].filter((v) => typeof v === 'string' && v !== '').join(', ')
    if (where !== '') info.From = where
    if (typeof s.language === 'string' && s.language !== '') info.Language = s.language.slice(0, 60)
    if (typeof s.codec === 'string' && s.codec !== '')
      info.Stream = `${s.codec}${finite(s.bitrate) && s.bitrate > 0 ? ` ${s.bitrate} kbps` : ''}`
    if (typeof s.homepage === 'string' && s.homepage.startsWith('https://'))
      info.Homepage = s.homepage.slice(0, 200)
    out.push({
      id: `radio:${String(s.stationuuid ?? out.length)}`,
      lat: r5(s.geo_lat),
      lon: r5(s.geo_long),
      label: name,
      kind: 'radio station',
      stream,
      ...(finite(s.clickcount) ? { value: s.clickcount } : {}),
      info,
    })
    if (out.length >= MAX_STATIONS) break
  }
  return out
}

export function radioProvider(up: Upstream): Provider {
  const kept = new Map<string, { at: number; features: Feature[] }>()
  return {
    async fetch(q) {
      const c = centreOf(q.bbox)
      const lat = Math.round(c.lat * 10) / 10
      const lon = Math.round(c.lon * 10) / 10
      const radius = Math.min(MAX_RADIUS_M, Math.round(c.radiusM / 10_000) * 10_000 + 10_000)
      const path = `/json/stations/search?geo_lat=${lat}&geo_long=${lon}&geo_distance=${radius}&limit=${MAX_STATIONS * 2}&hidebroken=true&order=clickcount&reverse=true`
      const hit = kept.get(path)
      if (hit !== undefined && q.now - hit.at < RADIO_MS)
        return { features: hit.features.filter((f) => inBbox(q.bbox, f.lat, f.lon)) }
      const body = await firstOf(
        'Radio Browser',
        RADIO_HOSTS.map(
          (h) => () => up.json(`${h}${path}`, { signal: q.signal, timeoutMs: 12_000 }),
        ),
      )
      const features = stationFeatures(body)
      if (kept.size > 32) kept.clear()
      kept.set(path, { at: q.now, features })
      return { features: features.filter((f) => inBbox(q.bbox, f.lat, f.lon)) }
    },
  }
}
