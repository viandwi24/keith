// Transit: live vehicle positions from keyless GTFS-Realtime feeds (Malaysia's data.gov.my for Rapid KL, Rapid Penang, MRT feeders
// and myBAS Johor; Helsinki HSL; Boston MBTA; the Netherlands OVapi; South East Queensland TransLink), asked only when the view
// overlaps a feed's region. GTFS-Realtime is protobuf: the few fields used are read by a small decoder here, no dependency.
import type { Upstream } from '../upstream.ts'
import { overlaps } from './cameras.ts'
import { type Bbox, type Feature, finite, inBbox, type Provider, r5 } from './types.ts'

const FEED_MS = 15_000
const MAX_VEHICLES = 1_500
/** A fix older than this is dropped (a vehicle that stopped reporting). */
const STALE_MS = 10 * 60_000

export interface Feed {
  id: string
  url: string
  region: Bbox
  operator: string
}

export const FEEDS: Feed[] = [
  {
    id: 'rapid-kl',
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana/?category=rapid-bus-kl',
    region: [2.7, 3.5, 101.2, 102.0],
    operator: 'Rapid KL',
  },
  {
    id: 'mrt-feeder',
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana/?category=rapid-bus-mrtfeeder',
    region: [2.7, 3.5, 101.2, 102.0],
    operator: 'Rapid KL MRT feeder',
  },
  {
    id: 'rapid-penang',
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana/?category=rapid-bus-penang',
    region: [5.0, 5.7, 100.1, 100.7],
    operator: 'Rapid Penang',
  },
  {
    id: 'mybas-johor',
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/mybas-johor/',
    region: [1.2, 2.1, 103.2, 104.2],
    operator: 'myBAS Johor',
  },
  {
    id: 'hsl',
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    region: [59.9, 60.6, 24.2, 25.6],
    operator: 'HSL',
  },
  {
    id: 'mbta',
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    region: [41.6, 42.9, -71.9, -70.5],
    operator: 'MBTA',
  },
  {
    id: 'ovapi',
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    region: [50.7, 53.6, 3.3, 7.3],
    operator: 'OVapi (Netherlands)',
  },
  {
    id: 'seq',
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions',
    region: [-28.4, -26.2, 152.0, 153.6],
    operator: 'TransLink SEQ',
  },
]

type Value = number | Uint8Array

/** The fields of one protobuf message: `[field number, value]`; varints as numbers (exact below 2^53), fixed32 as raw 4 bytes. */
export function fieldsOf(buf: Uint8Array): [number, Value, number][] {
  const out: [number, Value, number][] = []
  let i = 0
  const varint = (): number => {
    let v = 0
    let mul = 1
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++] as number
      v += (b & 0x7f) * mul
      if ((b & 0x80) === 0) return v
      mul *= 128
    }
    throw new Error('bad varint')
  }
  while (i < buf.length) {
    const key = varint()
    const no = Math.floor(key / 8)
    const wt = key % 8
    if (wt === 0) out.push([no, varint(), wt])
    else if (wt === 1) {
      out.push([no, buf.subarray(i, i + 8), wt])
      i += 8
    } else if (wt === 2) {
      const len = varint()
      if (i + len > buf.length) throw new Error('truncated field')
      out.push([no, buf.subarray(i, i + len), wt])
      i += len
    } else if (wt === 5) {
      out.push([no, buf.subarray(i, i + 4), wt])
      i += 4
    } else throw new Error(`wire type ${wt}`)
  }
  return out
}

const text = (v: Value | undefined) =>
  v instanceof Uint8Array ? new TextDecoder().decode(v).slice(0, 80) : undefined
const float = (v: Value | undefined) =>
  v instanceof Uint8Array && v.length === 4
    ? new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true)
    : undefined
const first = (fields: [number, Value, number][], no: number) =>
  fields.find((f) => f[0] === no)?.[1]

export interface Vehicle {
  id: string
  lat: number
  lon: number
  bearing?: number
  speed?: number
  route?: string
  label?: string
  timestamp?: number
}

/** The vehicle positions of a GTFS-Realtime `FeedMessage`. */
export function decodeVehicles(buf: Uint8Array): { header?: number; vehicles: Vehicle[] } {
  const msg = fieldsOf(buf)
  const head = first(msg, 1)
  const headerTs = head instanceof Uint8Array ? first(fieldsOf(head), 3) : undefined
  const vehicles: Vehicle[] = []
  for (const [no, entity] of msg) {
    if (no !== 2 || !(entity instanceof Uint8Array)) continue
    const e = fieldsOf(entity)
    const vp = first(e, 4)
    if (!(vp instanceof Uint8Array)) continue
    const v = fieldsOf(vp)
    const pos = first(v, 2)
    if (!(pos instanceof Uint8Array)) continue
    const p = fieldsOf(pos)
    const lat = float(first(p, 1))
    const lon = float(first(p, 2))
    if (lat === undefined || lon === undefined || !finite(lat) || !finite(lon)) continue
    if (lat === 0 && lon === 0) continue
    const trip = first(v, 1)
    const desc = first(v, 8)
    const t = trip instanceof Uint8Array ? fieldsOf(trip) : []
    const d = desc instanceof Uint8Array ? fieldsOf(desc) : []
    const out: Vehicle = {
      id: text(first(d, 1)) ?? text(first(e, 1)) ?? String(vehicles.length),
      lat,
      lon,
    }
    const bearing = float(first(p, 3))
    if (bearing !== undefined && finite(bearing)) out.bearing = bearing
    const speed = float(first(p, 5))
    if (speed !== undefined && finite(speed) && speed >= 0) out.speed = speed
    const route = text(first(t, 5))
    if (route !== undefined && route !== '') out.route = route
    const label = text(first(d, 2)) ?? text(first(d, 3))
    if (label !== undefined && label !== '') out.label = label
    const ts = first(v, 5)
    if (typeof ts === 'number' && ts > 0) out.timestamp = ts
    vehicles.push(out)
  }
  return typeof headerTs === 'number' ? { header: headerTs, vehicles } : { vehicles }
}

export function vehicleFeatures(feed: Feed, buf: Uint8Array, now: number): Feature[] {
  const { header, vehicles } = decodeVehicles(buf)
  const out: Feature[] = []
  for (const v of vehicles) {
    const at = (v.timestamp ?? header ?? now / 1000) * 1000
    if (now - at > STALE_MS) continue
    const f: Feature = {
      id: `tr:${feed.id}:${v.id}`.slice(0, 80),
      lat: r5(v.lat),
      lon: r5(v.lon),
      label: v.route ?? v.label ?? v.id,
      kind: 'vehicle',
      at,
      info: {
        ...(v.route === undefined ? {} : { Route: v.route }),
        ...(v.label === undefined ? {} : { Vehicle: v.label }),
        ...(v.speed === undefined ? {} : { Speed: `${Math.round(v.speed * 3.6)} km/h` }),
        Operator: feed.operator,
      },
    }
    if (v.bearing !== undefined) f.heading = v.bearing
    if (v.speed !== undefined && v.bearing !== undefined) f.speed = Math.round(v.speed * 10) / 10
    out.push(f)
  }
  return out
}

export function transitProvider(up: Upstream): Provider {
  const kept = new Map<string, { at: number; features: Feature[] }>()
  return {
    async fetch(q) {
      const feeds = FEEDS.filter((f) => overlaps(f.region, q.bbox))
      if (feeds.length === 0)
        return {
          features: [],
          note: 'no live feed here (Kuala Lumpur, Penang, Johor, Helsinki, Boston, the Netherlands, Brisbane)',
        }
      const features: Feature[] = []
      const failed: string[] = []
      for (const feed of feeds) {
        let hit = kept.get(feed.id)
        if (hit === undefined || q.now - hit.at >= FEED_MS) {
          try {
            const buf = await up.bytes(feed.url, { signal: q.signal, timeoutMs: 15_000 })
            hit = { at: q.now, features: vehicleFeatures(feed, buf, q.now) }
            kept.set(feed.id, hit)
          } catch {
            failed.push(feed.operator)
            if (hit === undefined) continue
          }
        }
        for (const f of hit.features)
          if (features.length < MAX_VEHICLES && inBbox(q.bbox, f.lat, f.lon)) features.push(f)
      }
      if (failed.length === feeds.length) throw new Error(`${failed.join(', ')} did not answer`)
      return failed.length > 0
        ? { features, note: `${failed.join(', ')} did not answer` }
        : { features }
    },
  }
}
