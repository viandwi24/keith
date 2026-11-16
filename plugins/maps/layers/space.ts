// Space: satellites from CelesTrak's general perturbations (OMM JSON), propagated with SGP4 (satellite.js) into a track the map
// follows for the next minutes; and the next rocket launches from Launch Library 2 at their pads. Both sources ask clients to fetch
// rarely: element sets are kept 6 hours, launches 30 minutes.
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from 'satellite.js'
import type { Upstream } from '../upstream.ts'
import { type Feature, finite, type Provider, r5 } from './types.ts'

export const CELESTRAK = 'https://celestrak.org'
export const LL2 = 'https://ll.thespacedevs.com'

/** The CelesTrak groups shown, with how many of each at most. */
export const GROUPS: { group: string; kind: string; max: number }[] = [
  { group: 'stations', kind: 'station', max: 40 },
  { group: 'visual', kind: 'bright', max: 160 },
  { group: 'weather', kind: 'weather', max: 80 },
  { group: 'gps-ops', kind: 'navigation', max: 40 },
  { group: 'resource', kind: 'imaging', max: 160 },
]
const ELEMENTS_MS = 6 * 3_600_000
const LAUNCHES_MS = 30 * 60_000
/** A track: a sample every 30 s from a minute ago to 10 minutes ahead. */
const STEP_MS = 30_000
const BEFORE_MS = 60_000
const AHEAD_MS = 600_000

/** A tracked satellite's samples `[t, lat, lon, alt m]`, or undefined when SGP4 fails (a decayed object). */
export function trackOf(omm: Record<string, unknown>, now: number): Feature['track'] {
  let rec: ReturnType<typeof json2satrec>
  try {
    rec = json2satrec(omm as unknown as Parameters<typeof json2satrec>[0])
  } catch {
    return undefined
  }
  const out: [number, number, number, number][] = []
  for (let t = now - BEFORE_MS; t <= now + AHEAD_MS; t += STEP_MS) {
    const date = new Date(t)
    const pv = propagate(rec, date)
    if (pv === null || typeof pv.position !== 'object') return undefined
    const geo = eciToGeodetic(pv.position, gstime(date))
    const lat = degreesLat(geo.latitude)
    const lon = degreesLong(geo.longitude)
    const altM = geo.height * 1000
    if (!finite(lat) || !finite(lon) || !finite(altM) || altM < 80_000) return undefined
    out.push([t, r5(lat), r5(lon), Math.round(altM)])
  }
  return out
}

/** How long a call waits for element sets before it answers with what it has (CelesTrak can take half a minute). */
export const ELEMENTS_WAIT_MS = 8_000

export function satellitesProvider(up: Upstream, options: { waitMs?: number } = {}): Provider {
  const kept = new Map<string, { at: number; list: Record<string, unknown>[] }>()
  const loading = new Map<string, Promise<void>>()
  let lastError: unknown

  /** Starts loading a group unless it is fresh or already loading; a failure keeps the old set. */
  function refresh(group: string, now: number): Promise<void> | undefined {
    const hit = kept.get(group)
    if (hit !== undefined && now - hit.at < ELEMENTS_MS) return undefined
    const running = loading.get(group)
    if (running !== undefined) return running
    const job = up
      // not the call's signal: a load outlives the call that started it, and the next call uses it
      .json(`${CELESTRAK}/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`, {
        signal: AbortSignal.timeout(60_000),
        timeoutMs: 60_000,
      })
      .then((body) => {
        const list = Array.isArray(body)
          ? body.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          : []
        kept.set(group, { at: Date.now(), list })
      })
      .catch((error: unknown) => {
        lastError = error
      })
      .finally(() => loading.delete(group))
    loading.set(group, job)
    return job
  }

  return {
    async fetch(q) {
      const jobs = GROUPS.map((g) => refresh(g.group, q.now)).filter((j) => j !== undefined)
      if (jobs.length > 0)
        await Promise.race([Promise.all(jobs), Bun.sleep(options.waitMs ?? ELEMENTS_WAIT_MS)])
      const seen = new Set<string>()
      const features: Feature[] = []
      for (const g of GROUPS) {
        const list = kept.get(g.group)?.list ?? []
        let n = 0
        for (const omm of list) {
          if (n >= g.max) break
          const id = String(omm.NORAD_CAT_ID ?? omm.OBJECT_ID ?? '')
          if (id === '' || seen.has(id)) continue
          const track = trackOf(omm, q.now)
          const here = track?.[Math.round(BEFORE_MS / STEP_MS)]
          if (track === undefined || here === undefined) continue
          seen.add(id)
          n++
          const name = typeof omm.OBJECT_NAME === 'string' ? omm.OBJECT_NAME : id
          const motion = finite(omm.MEAN_MOTION) ? omm.MEAN_MOTION : 0
          features.push({
            id: `sat:${id}`,
            lat: here[1],
            lon: here[2],
            alt: here[3],
            label: name,
            kind: g.kind,
            track,
            info: {
              Name: name,
              NORAD: id,
              Altitude: `${Math.round(here[3] / 1000)} km`,
              ...(motion > 0 ? { Period: `${Math.round(1440 / motion)} min` } : {}),
              ...(finite(omm.INCLINATION) ? { Inclination: `${omm.INCLINATION.toFixed(1)}°` } : {}),
              Group: g.group,
            },
          })
        }
      }
      const missing = GROUPS.filter((g) => kept.get(g.group) === undefined).length
      if (features.length === 0 && loading.size === 0 && lastError !== undefined) throw lastError
      if (missing > 0 && loading.size > 0)
        return { features, note: 'loading satellite elements from CelesTrak' }
      return { features }
    },
  }
}

export function launchesProvider(up: Upstream): Provider {
  let kept: { at: number; features: Feature[] } | undefined
  return {
    async fetch(q) {
      if (kept !== undefined && q.now - kept.at < LAUNCHES_MS) return { features: kept.features }
      const body = (await up.json(`${LL2}/2.3.0/launches/upcoming/?limit=20&mode=normal`, {
        signal: q.signal,
        timeoutMs: 20_000,
      })) as { results?: unknown }
      const features: Feature[] = []
      for (const raw of Array.isArray(body.results) ? body.results : []) {
        if (typeof raw !== 'object' || raw === null) continue
        const l = raw as Record<string, unknown>
        const pad = (l.pad ?? {}) as Record<string, unknown>
        const lat = Number(pad.latitude)
        const lon = Number(pad.longitude)
        if (!finite(lat) || !finite(lon)) continue
        const status = ((l.status ?? {}) as Record<string, unknown>).name
        const provider = ((l.launch_service_provider ?? {}) as Record<string, unknown>).name
        const mission = ((l.mission ?? {}) as Record<string, unknown>).description
        features.push({
          id: `launch:${String(l.id ?? features.length)}`,
          lat: r5(lat),
          lon: r5(lon),
          label: typeof l.name === 'string' ? l.name.slice(0, 80) : 'Launch',
          kind: typeof status === 'string' ? status : 'planned',
          info: {
            When: typeof l.net === 'string' ? l.net.replace('T', ' ').replace('Z', ' UTC') : '?',
            ...(typeof provider === 'string' ? { Provider: provider } : {}),
            ...(typeof pad.name === 'string' ? { Pad: pad.name } : {}),
            ...(typeof status === 'string' ? { Status: status } : {}),
            ...(typeof mission === 'string' ? { Mission: mission.slice(0, 200) } : {}),
          },
        })
      }
      kept = { at: q.now, features }
      return { features }
    },
  }
}
