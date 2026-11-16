// Small geometry helpers of the maps plugin (pure): distance, an encoded polyline, line simplification, a bounding box.

export type LatLon = [lat: number, lon: number]

const R = 6_371_008.8

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLon = (b[1] - a[1]) * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Decodes a Google encoded polyline (`precision` 6 for Valhalla, 5 for others) into `[lat, lon]` points. */
export function decodePolyline(encoded: string, precision = 6): LatLon[] {
  const factor = 10 ** precision
  const points: LatLon[] = []
  let i = 0
  let lat = 0
  let lon = 0
  const next = (): number | undefined => {
    let result = 0
    let shift = 0
    let byte: number
    do {
      if (i >= encoded.length) return undefined
      byte = encoded.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20 && shift < 35)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < encoded.length) {
    const dLat = next()
    const dLon = next()
    if (dLat === undefined || dLon === undefined) break
    lat += dLat
    lon += dLon
    points.push([lat / factor, lon / factor])
  }
  return points
}

/** Squared distance of `p` to the segment `a`-`b`, in degrees (planar: fine at the scale of one simplification step). */
function segmentDistance2(p: LatLon, a: LatLon, b: LatLon): number {
  let [x, y] = a
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/** Douglas-Peucker with tolerance `epsilon` (degrees); keeps the first and last point. */
function douglasPeucker(points: LatLon[], epsilon: number): LatLon[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  const eps2 = epsilon * epsilon
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let max = 0
    let index = -1
    for (let k = first + 1; k < last; k++) {
      const d = segmentDistance2(
        points[k] as LatLon,
        points[first] as LatLon,
        points[last] as LatLon,
      )
      if (d > max) {
        max = d
        index = k
      }
    }
    if (index !== -1 && max > eps2) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return points.filter((_, k) => keep[k] === 1)
}

/** At most `max` points: Douglas-Peucker from about one metre, the tolerance doubled until the line fits; coordinates to 5 decimals. */
export function simplify(points: LatLon[], max: number): LatLon[] {
  let epsilon = 0.00001
  let out = douglasPeucker(points, epsilon)
  while (out.length > max && epsilon < 1) {
    epsilon *= 2
    out = douglasPeucker(points, epsilon)
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5
  return out.map(([lat, lon]) => [round(lat), round(lon)])
}

/** `[south, north, west, east]` of the points (no antimeridian handling: routes do not cross it). */
export function bboxOf(points: LatLon[]): [number, number, number, number] {
  let s = 90
  let n = -90
  let w = 180
  let e = -180
  for (const [lat, lon] of points) {
    s = Math.min(s, lat)
    n = Math.max(n, lat)
    w = Math.min(w, lon)
    e = Math.max(e, lon)
  }
  return [s, n, w, e]
}
