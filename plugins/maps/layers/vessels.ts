// Ships: live AIS positions from AISStream.io, which needs a free API key (the `aisstreamKey` setting). AISStream is a websocket
// stream, not a question and answer: one socket follows the last view asked (its subscription is replaced when the view moves), ships
// are kept 15 minutes, and the socket closes after two minutes nobody asks. The first answer after a view is new may be nearly empty.
import type { Upstream } from '../upstream.ts'
import { type Bbox, type Feature, finite, inBbox, type Provider, r5 } from './types.ts'

export const AISSTREAM = 'wss://stream.aisstream.io/v0/stream'
const KEEP_MS = 15 * 60_000
const IDLE_MS = 2 * 60_000
const MAX_SHIPS = 2_000
const KNOT = 0.514_444

/** The part of a WebSocket used here, so tests can give a fake one. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

interface Ship {
  mmsi: string
  lat: number
  lon: number
  at: number
  name?: string
  sog?: number
  cog?: number
  heading?: number
  status?: number
  destination?: string
  type?: number
  callsign?: string
}

const STATUS = [
  'under way (engine)',
  'at anchor',
  'not under command',
  'restricted manoeuvrability',
  'constrained by draught',
  'moored',
  'aground',
  'fishing',
  'under way (sail)',
]

/** The ship type group of an AIS type code. */
export function shipKind(type: number | undefined): string {
  if (type === undefined) return 'ship'
  if (type >= 70 && type <= 79) return 'cargo'
  if (type >= 80 && type <= 89) return 'tanker'
  if (type >= 60 && type <= 69) return 'passenger'
  if (type === 30) return 'fishing'
  if (type === 35) return 'military'
  if (type === 36 || type === 37) return 'pleasure craft'
  if (type >= 31 && type <= 32) return 'towing'
  if (type === 52) return 'tug'
  if (type === 50 || type === 51 || type === 53 || type === 55) return 'service'
  return 'ship'
}

/** Folds one AISStream message into the ships kept. */
export function applyMessage(ships: Map<string, Ship>, raw: unknown, now: number): void {
  const m = raw as {
    MessageType?: unknown
    MetaData?: Record<string, unknown>
    Message?: Record<string, Record<string, unknown>>
  }
  const meta = m.MetaData ?? {}
  const mmsi = finite(meta.MMSI) ? String(meta.MMSI) : undefined
  if (mmsi === undefined) return
  const ship: Ship = ships.get(mmsi) ?? { mmsi, lat: Number.NaN, lon: Number.NaN, at: now }
  const name = typeof meta.ShipName === 'string' ? meta.ShipName.trim() : ''
  if (name !== '') ship.name = name.slice(0, 60)
  if (m.MessageType === 'PositionReport') {
    const p = m.Message?.PositionReport ?? {}
    const lat = finite(meta.latitude) ? meta.latitude : p.Latitude
    const lon = finite(meta.longitude) ? meta.longitude : p.Longitude
    if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return
    ship.lat = lat
    ship.lon = lon
    ship.at = now
    if (finite(p.Sog) && p.Sog < 102.3) ship.sog = p.Sog
    if (finite(p.Cog) && p.Cog < 360) ship.cog = p.Cog
    if (finite(p.TrueHeading) && p.TrueHeading < 360) ship.heading = p.TrueHeading
    if (finite(p.NavigationalStatus)) ship.status = p.NavigationalStatus
  } else if (m.MessageType === 'ShipStaticData') {
    const s = m.Message?.ShipStaticData ?? {}
    if (typeof s.Destination === 'string' && s.Destination.trim() !== '')
      ship.destination = s.Destination.trim().slice(0, 60)
    if (finite(s.Type)) ship.type = s.Type
    if (typeof s.CallSign === 'string' && s.CallSign.trim() !== '')
      ship.callsign = s.CallSign.trim().slice(0, 20)
    if (typeof s.Name === 'string' && s.Name.trim() !== '') ship.name = s.Name.trim().slice(0, 60)
  } else return
  ships.set(mmsi, ship)
  if (ships.size > MAX_SHIPS * 2) {
    const oldest = [...ships.values()].sort((a, b) => a.at - b.at).slice(0, ships.size - MAX_SHIPS)
    for (const o of oldest) ships.delete(o.mmsi)
  }
}

export function shipFeatures(ships: Map<string, Ship>, b: Bbox, now: number): Feature[] {
  const out: Feature[] = []
  for (const s of ships.values()) {
    if (!finite(s.lat) || now - s.at > KEEP_MS || !inBbox(b, s.lat, s.lon)) continue
    const heading = s.heading ?? s.cog
    const f: Feature = {
      id: `ais:${s.mmsi}`,
      lat: r5(s.lat),
      lon: r5(s.lon),
      label: s.name ?? s.mmsi,
      kind: shipKind(s.type),
      at: s.at,
      info: {
        ...(s.name === undefined ? {} : { Name: s.name }),
        MMSI: s.mmsi,
        ...(s.callsign === undefined ? {} : { Callsign: s.callsign }),
        Type: shipKind(s.type),
        ...(s.sog === undefined ? {} : { Speed: `${s.sog.toFixed(1)} kt` }),
        ...(s.cog === undefined ? {} : { Course: `${Math.round(s.cog)}°` }),
        ...(s.status === undefined || STATUS[s.status] === undefined
          ? {}
          : { Status: STATUS[s.status] as string }),
        ...(s.destination === undefined ? {} : { Destination: s.destination }),
        Source: 'AISStream',
      },
    }
    if (heading !== undefined) f.heading = heading
    if (s.sog !== undefined && s.sog > 0.5) f.speed = Math.round(s.sog * KNOT * 10) / 10
    out.push(f)
    if (out.length >= MAX_SHIPS) break
  }
  return out
}

/** The subscription for a view: AISStream takes boxes as `[[lat, lon], [lat, lon]]`; a view across the antimeridian is two boxes. */
export function subscription(key: string, b: Bbox): string {
  const [s, n, w, e] = b
  const boxes =
    w <= e
      ? [
          [
            [s, w],
            [n, e],
          ],
        ]
      : [
          [
            [s, w],
            [n, 180],
          ],
          [
            [s, -180],
            [n, e],
          ],
        ]
  return JSON.stringify({
    APIKey: key,
    BoundingBoxes: boxes,
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  })
}

export function vesselsProvider(
  _up: Upstream,
  options: { socket?: (url: string) => SocketLike; now?: () => number } = {},
): Provider {
  const open = options.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
  const clock = options.now ?? Date.now
  const ships = new Map<string, Ship>()
  let socket: SocketLike | undefined
  let ready = false
  let key = ''
  let view = ''
  let box: Bbox = [0, 0, 0, 0]
  let lastAsk = 0
  let failure: string | undefined
  let idle: ReturnType<typeof setInterval> | undefined

  function stop() {
    socket?.close()
    socket = undefined
    ready = false
    view = ''
    if (idle !== undefined) clearInterval(idle)
    idle = undefined
  }

  function connect() {
    const s = open(AISSTREAM)
    socket = s
    ready = false
    s.onopen = () => {
      ready = true
      failure = undefined
      s.send(subscription(key, box))
    }
    s.onmessage = (ev) => {
      const data =
        typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
      try {
        const msg = JSON.parse(data) as { error?: unknown }
        if (typeof msg.error === 'string') {
          failure = `AISStream: ${msg.error.slice(0, 120)}`
          return
        }
        applyMessage(ships, msg, clock())
      } catch {
        // a message that is not JSON is skipped
      }
    }
    s.onerror = () => {
      failure = 'AISStream could not be reached'
    }
    s.onclose = () => {
      if (socket === s) {
        socket = undefined
        ready = false
        view = ''
      }
    }
    idle ??= setInterval(() => {
      if (clock() - lastAsk > IDLE_MS) stop()
    }, 30_000)
  }

  return {
    async fetch(q) {
      const k = q.config.aisstreamKey
      if (k === undefined)
        return {
          features: [],
          note: 'needs the aisstreamKey setting (a free key from aisstream.io)',
        }
      lastAsk = q.now
      if (k !== key) {
        stop()
        key = k
      }
      // a view counts as new when it moved by more than a tenth of a degree
      const snap = q.bbox.map((v) => Math.round(v * 10) / 10) as Bbox
      const next = snap.join(',')
      if (next !== view) {
        view = next
        box = snap
        if (socket !== undefined && ready) socket.send(subscription(key, box))
      }
      if (socket === undefined) connect()
      const features = shipFeatures(ships, q.bbox, q.now)
      if (failure !== undefined && features.length === 0) throw new Error(failure)
      return features.length === 0
        ? { features, note: 'listening to AIS; ships appear as they report' }
        : { features }
    },
  }
}
