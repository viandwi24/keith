// Events: earthquakes of the last day (USGS, magnitude 2.5 and up) with Indonesia's latest felt ones (BMKG, which also says whether a
// tsunami may follow), and open natural events from NASA EONET (wildfires, storms with their track, volcanoes, floods, ice).
import type { Upstream } from '../upstream.ts'
import { type Feature, finite, type Provider, r5 } from './types.ts'

export const USGS = 'https://earthquake.usgs.gov'
export const BMKG = 'https://data.bmkg.go.id'
export const EONET = 'https://eonet.gsfc.nasa.gov'

const QUAKES_MS = 5 * 60_000
const EVENTS_MS = 30 * 60_000

/** USGS GeoJSON features as quakes. */
export function usgsQuakes(body: unknown): Feature[] {
  const list = (body as { features?: unknown })?.features
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const f = raw as {
      id?: unknown
      properties?: Record<string, unknown>
      geometry?: { coordinates?: unknown }
    }
    const c = f.geometry?.coordinates
    const p = f.properties ?? {}
    if (!Array.isArray(c) || !finite(c[0]) || !finite(c[1]) || !finite(p.mag)) continue
    const depth = finite(c[2]) ? c[2] : 0
    out.push({
      id: `usgs:${String(f.id ?? out.length)}`,
      lat: r5(c[1]),
      lon: r5(c[0]),
      label: `M${p.mag.toFixed(1)}`,
      kind: p.tsunami === 1 ? 'tsunami warning' : 'quake',
      size: p.mag,
      info: {
        Magnitude: p.mag.toFixed(1),
        Place: typeof p.place === 'string' ? p.place : '?',
        Depth: `${Math.round(depth)} km`,
        ...(finite(p.time)
          ? { When: new Date(p.time).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }
          : {}),
        ...(typeof p.alert === 'string' ? { Alert: p.alert } : {}),
        Source: 'USGS',
      },
      ...(finite(p.time) ? { at: p.time } : {}),
    })
  }
  return out
}

/** BMKG's latest felt quakes (`gempaterkini.json`): coordinates "lat,lon", magnitude and depth as text. */
export function bmkgQuakes(body: unknown): Feature[] {
  const list = (body as { Infogempa?: { gempa?: unknown } })?.Infogempa?.gempa
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const g = raw as Record<string, unknown>
    const [lat, lon] = String(g.Coordinates ?? '')
      .split(',')
      .map(Number)
    const mag = Number(g.Magnitude)
    if (!finite(lat) || !finite(lon) || !finite(mag)) continue
    const when = typeof g.DateTime === 'string' ? Date.parse(g.DateTime) : Number.NaN
    out.push({
      id: `bmkg:${String(g.DateTime ?? out.length)}`,
      lat: r5(lat),
      lon: r5(lon),
      label: `M${mag.toFixed(1)}`,
      kind:
        String(g.Potensi ?? '')
          .toLowerCase()
          .includes('berpotensi tsunami') && !String(g.Potensi).toLowerCase().includes('tidak')
          ? 'tsunami warning'
          : 'quake',
      size: mag,
      info: {
        Magnitude: mag.toFixed(1),
        Place: String(g.Wilayah ?? '?'),
        Depth: String(g.Kedalaman ?? '?'),
        When: `${String(g.Tanggal ?? '')} ${String(g.Jam ?? '')}`.trim(),
        ...(typeof g.Potensi === 'string' ? { Tsunami: g.Potensi } : {}),
        Source: 'BMKG',
      },
      ...(finite(when) ? { at: when } : {}),
    })
  }
  return out
}

export function quakesProvider(up: Upstream): Provider {
  let kept: { at: number; features: Feature[]; note?: string } | undefined
  return {
    async fetch(q) {
      if (kept !== undefined && q.now - kept.at < QUAKES_MS)
        return kept.note === undefined
          ? { features: kept.features }
          : { features: kept.features, note: kept.note }
      const [usgs, bmkg] = await Promise.allSettled([
        up.json(`${USGS}/earthquakes/feed/v1.0/summary/2.5_day.geojson`, {
          signal: q.signal,
          timeoutMs: 15_000,
        }),
        up.json(`${BMKG}/DataMKG/TEWS/gempaterkini.json`, { signal: q.signal, timeoutMs: 15_000 }),
      ])
      if (usgs.status === 'rejected' && bmkg.status === 'rejected') throw usgs.reason
      const features = [
        ...(bmkg.status === 'fulfilled' ? bmkgQuakes(bmkg.value) : []),
        ...(usgs.status === 'fulfilled' ? usgsQuakes(usgs.value) : []),
      ]
      const note =
        usgs.status === 'rejected'
          ? 'USGS did not answer'
          : bmkg.status === 'rejected'
            ? 'BMKG did not answer'
            : undefined
      kept = note === undefined ? { at: q.now, features } : { at: q.now, features, note }
      return note === undefined ? { features } : { features, note }
    },
  }
}

/** EONET events: the last point is where it is now; a storm's earlier points are its track. */
export function eonetEvents(body: unknown): Feature[] {
  const list = (body as { events?: unknown })?.events
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    const e = raw as Record<string, unknown>
    const geo = Array.isArray(e.geometry) ? (e.geometry as Record<string, unknown>[]) : []
    const points: [number, number][] = []
    let lastDate = ''
    let magnitude = ''
    for (const g of geo) {
      if (g.type !== 'Point' || !Array.isArray(g.coordinates)) continue
      const [lon, lat] = g.coordinates as unknown[]
      if (!finite(lat) || !finite(lon)) continue
      points.push([r5(lat), r5(lon)])
      if (typeof g.date === 'string') lastDate = g.date
      if (finite(g.magnitudeValue))
        magnitude = `${g.magnitudeValue} ${String(g.magnitudeUnit ?? '')}`.trim()
    }
    const here = points[points.length - 1]
    if (here === undefined) continue
    const category = Array.isArray(e.categories)
      ? String((e.categories[0] as Record<string, unknown>)?.title ?? '')
      : ''
    const source = Array.isArray(e.sources)
      ? String((e.sources[0] as Record<string, unknown>)?.id ?? '')
      : ''
    const f: Feature = {
      id: `eonet:${String(e.id ?? out.length)}`,
      lat: here[0],
      lon: here[1],
      label: typeof e.title === 'string' ? e.title.slice(0, 80) : category,
      kind: category || 'event',
      info: {
        Event: typeof e.title === 'string' ? e.title.slice(0, 200) : '?',
        Category: category || '?',
        ...(lastDate === '' ? {} : { Updated: lastDate.replace('T', ' ').slice(0, 16) + ' UTC' }),
        ...(magnitude === '' ? {} : { Size: magnitude }),
        ...(source === '' ? {} : { Source: source }),
      },
    }
    if (points.length > 1) f.line = points.slice(-400)
    out.push(f)
  }
  return out
}

export function eventsProvider(up: Upstream): Provider {
  let kept: { at: number; features: Feature[] } | undefined
  return {
    async fetch(q) {
      if (kept !== undefined && q.now - kept.at < EVENTS_MS) return { features: kept.features }
      const body = await up.json(`${EONET}/api/v3/events?status=open&days=30&limit=400`, {
        signal: q.signal,
        timeoutMs: 20_000,
      })
      kept = { at: q.now, features: eonetEvents(body) }
      return { features: kept.features }
    },
  }
}
