// Flights: live aircraft around the view from adsb.lol (keyless, ODbL; readsb's JSON), and the same JSON from the owner's own
// receivers (an SDR running readsb or dump1090: `aircraft.json`). Positions older than a minute are dropped.
import type { Upstream } from '../upstream.ts'
import { centreOf, type Feature, finite, type Provider, r5 } from './types.ts'

export const ADSB_LOL = 'https://api.adsb.lol'
/** adsb.lol answers at most 250 nautical miles around a point. */
const MAX_NM = 250
const MAX_FLIGHTS = 1_500
const STALE_S = 60
const FT = 0.3048
const KNOT = 0.514_444

/** readsb's database flag for a military aircraft. */
const MILITARY = 1

/**
 * Aircraft of a readsb answer as features: callsign, registration, type, altitude, ground speed and track. `nowMs` is when the
 * answer was made (its `now`, else ours); `seen_pos` ages each fix.
 */
export function aircraftFeatures(list: unknown, nowMs: number, source: string): Feature[] {
  if (!Array.isArray(list)) return []
  const out: Feature[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as Record<string, unknown>
    if (!finite(a.lat) || !finite(a.lon) || typeof a.hex !== 'string') continue
    const seen = finite(a.seen_pos) ? a.seen_pos : 0
    if (seen > STALE_S) continue
    const ground = a.alt_baro === 'ground'
    const altFt = finite(a.alt_geom) ? a.alt_geom : finite(a.alt_baro) ? a.alt_baro : 0
    const callsign = typeof a.flight === 'string' ? a.flight.trim() : ''
    const military = finite(a.dbFlags) && (a.dbFlags & MILITARY) === MILITARY
    const info: Record<string, string | number> = {}
    if (callsign !== '') info.Callsign = callsign
    if (typeof a.r === 'string') info.Registration = a.r
    if (typeof a.t === 'string') info.Type = a.t
    info.Altitude = ground ? 'on the ground' : `${Math.round(altFt)} ft`
    if (finite(a.gs)) info.Speed = `${Math.round(a.gs)} kt`
    if (finite(a.track)) info.Track = `${Math.round(a.track)}°`
    if (typeof a.squawk === 'string') info.Squawk = a.squawk
    info.Hex = a.hex
    info.Source = source
    const f: Feature = {
      id: `ac:${a.hex}`,
      lat: r5(a.lat),
      lon: r5(a.lon),
      alt: ground ? 0 : Math.round(altFt * FT),
      label: callsign !== '' ? callsign : typeof a.r === 'string' ? a.r : a.hex,
      kind: military ? 'military' : ground ? 'ground' : 'airborne',
      info,
      at: nowMs - seen * 1000,
    }
    if (finite(a.track)) f.heading = a.track
    if (finite(a.gs) && !ground) f.speed = Math.round(a.gs * KNOT * 10) / 10
    out.push(f)
    if (out.length >= MAX_FLIGHTS) break
  }
  return out
}

export function flightsProvider(up: Upstream): Provider {
  return {
    async fetch(q) {
      const c = centreOf(q.bbox)
      const nm = Math.max(5, Math.min(MAX_NM, Math.round(c.radiusM / 1852)))
      const url = `${ADSB_LOL}/v2/point/${c.lat.toFixed(3)}/${c.lon.toFixed(3)}/${nm}`
      const body = (await up.json(url, { signal: q.signal, timeoutMs: 12_000 })) as {
        ac?: unknown
        now?: unknown
      }
      const now = finite(body.now) ? body.now : q.now
      const features = aircraftFeatures(body.ac, now, 'adsb.lol')
      return nm === MAX_NM && c.radiusM / 1852 > MAX_NM
        ? { features, note: 'aircraft within 250 nm of the centre only' }
        : { features }
    },
  }
}

/** The owner's own receivers (`receivers` setting): each `aircraft.json` read in turn; a failing one is skipped. */
export function receiversProvider(up: Upstream): Provider {
  return {
    async fetch(q) {
      const urls = q.config.receivers ?? []
      if (urls.length === 0)
        return {
          features: [],
          note: 'needs the receivers setting (readsb / dump1090 aircraft.json URLs)',
        }
      const features: Feature[] = []
      let failed = 0
      for (const url of urls) {
        try {
          const body = (await up.json(url, { signal: q.signal, timeoutMs: 5_000 })) as {
            aircraft?: unknown
            now?: unknown
          }
          const now = finite(body.now) ? body.now * 1000 : q.now
          for (const f of aircraftFeatures(body.aircraft, now, new URL(url).host))
            features.push({ ...f, id: `rx:${f.id}` })
        } catch {
          failed++
        }
      }
      if (failed === urls.length) throw new Error('no receiver answered')
      return failed > 0
        ? { features, note: `${failed} of ${urls.length} receivers did not answer` }
        : { features }
    },
  }
}
