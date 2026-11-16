// The map window's params, read by hand (the page has no zod): numbers in range, a known style and view, the data layers that are on,
// a route of valid positions, pins, and the person's (or Keith's) marks. `fitKey` names what the view was fitted to.

import { LAYER_IDS } from './catalog.js'
import { styleName } from './styles.js'
import { clampZoom } from './tiles.js'

/** @typedef {{ lat: number, lon: number, label?: string }} Pin */
/** @typedef {{ from: Pin, to: Pin, via: Pin[], mode: string }} RouteParams */
/** @typedef {{ kind: 'pin' | 'line' | 'area', points: [number, number][], label?: string, color?: string }} Mark */
/**
 * @typedef {{ lat: number, lon: number, zoom: number, label?: string, style: string, view: '2d' | '3d', layers: string[],
 *   route?: RouteParams, places: Pin[], marks: Mark[], fitted?: string }} MapParams
 */

const MODES = ['car', 'motorcycle', 'bike', 'foot']
export const VIEWS = /** @type {const} */ (['3d', '2d'])
export const MARK_KINDS = /** @type {const} */ (['pin', 'line', 'area'])
export const MARK_COLORS = /** @type {const} */ ([
  'indigo',
  'red',
  'amber',
  'green',
  'cyan',
  'white',
])
/** At most this many marks, and this many points in all of them: the params stay under the workspace's 4 KB. */
export const MAX_MARKS = 12
export const MAX_MARK_POINTS = 40

const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v)

/** @param {unknown} v @returns {Pin | undefined} */
export function readPin(v) {
  if (typeof v !== 'object' || v === null) return undefined
  const p = /** @type {Record<string, unknown>} */ (v)
  const { lat, lon } = p
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return undefined
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return undefined
  /** @type {Pin} */
  const pin = { lat, lon }
  if (typeof p.label === 'string' && p.label.trim() !== '') pin.label = p.label.trim().slice(0, 40)
  return pin
}

/** @param {unknown} v @returns {RouteParams | undefined} */
function readRoute(v) {
  if (typeof v !== 'object' || v === null) return undefined
  const r = /** @type {Record<string, unknown>} */ (v)
  const from = readPin(r.from)
  const to = readPin(r.to)
  if (from === undefined || to === undefined) return undefined
  const via = Array.isArray(r.via) ? r.via.slice(0, 3).map(readPin) : []
  if (via.some((p) => p === undefined)) return undefined
  const mode = typeof r.mode === 'string' && MODES.includes(r.mode) ? r.mode : 'car'
  return { from, to, via: /** @type {Pin[]} */ (via), mode }
}

/**
 * Marks with valid points only, each kind with enough of them (a line two, an area three), within the caps.
 * @param {unknown} v @returns {Mark[]}
 */
export function readMarks(v) {
  if (!Array.isArray(v)) return []
  /** @type {Mark[]} */
  const out = []
  let budget = MAX_MARK_POINTS
  for (const raw of v.slice(0, MAX_MARKS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const m = /** @type {Record<string, unknown>} */ (raw)
    const kind = MARK_KINDS.find((k) => k === m.kind)
    if (kind === undefined || !Array.isArray(m.points)) continue
    /** @type {[number, number][]} */
    const points = []
    for (const p of m.points.slice(0, budget)) {
      if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) continue
      const lat = /** @type {number} */ (p[0])
      const lon = /** @type {number} */ (p[1])
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
      points.push([lat, lon])
    }
    const need = kind === 'pin' ? 1 : kind === 'line' ? 2 : 3
    if (points.length < need) continue
    const kept = kind === 'pin' ? points.slice(0, 1) : points
    budget -= kept.length
    /** @type {Mark} */
    const mark = { kind, points: kept }
    if (typeof m.label === 'string' && m.label.trim() !== '')
      mark.label = m.label.trim().slice(0, 40)
    const color = MARK_COLORS.find((c) => c === m.color)
    if (color !== undefined) mark.color = color
    out.push(mark)
    if (budget <= 0) break
  }
  return out
}

/**
 * Validates map params by hand: numbers in range, an optional short label, a known style and view, known layers (each once, at most
 * 8), a route of valid positions (else no route), at most 20 valid pins and the marks (invalid ones dropped).
 * @param {unknown} value
 * @returns {MapParams | undefined}
 */
export function readParams(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const p = /** @type {Record<string, unknown>} */ (value)
  const centre = readPin({ lat: p.lat, lon: p.lon })
  if (centre === undefined) return undefined
  const zoom = finite(p.zoom) ? clampZoom(/** @type {number} */ (p.zoom)) : 13
  const view = p.view === '2d' ? '2d' : '3d'
  const layers = Array.isArray(p.layers)
    ? [...new Set(p.layers.filter((l) => typeof l === 'string' && LAYER_IDS.includes(l)))].slice(
        0,
        8,
      )
    : []
  /** @type {MapParams} */
  const out = {
    lat: centre.lat,
    lon: centre.lon,
    zoom,
    style: styleName(p.style),
    view,
    layers,
    places: [],
    marks: readMarks(p.marks),
  }
  if (typeof p.label === 'string' && p.label.trim() !== '') out.label = p.label.trim().slice(0, 80)
  const route = readRoute(p.route)
  if (route !== undefined) out.route = route
  if (Array.isArray(p.places)) {
    for (const raw of p.places.slice(0, 20)) {
      const pin = readPin(raw)
      if (pin !== undefined) out.places.push(pin)
    }
  }
  if (typeof p.fitted === 'string') out.fitted = p.fitted.slice(0, 400)
  return out
}

/**
 * What the view was fitted to: the route's stops and mode, and the pins, rounded. When the params' `fitted` equals it the person's
 * own pan and zoom are kept; a new route or new pins fit the view again. Empty when there is nothing to fit.
 * @param {MapParams} params
 * @returns {string}
 */
export function fitKey(params) {
  /** @param {Pin} p */
  const at = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`
  const parts = []
  if (params.route !== undefined) {
    const r = params.route
    parts.push(`${r.mode}:${[r.from, ...r.via, r.to].map(at).join(';')}`)
  }
  if (params.places.length > 0) parts.push(`p:${params.places.map(at).join(';')}`)
  return parts.join('|').slice(0, 400)
}

/** The stops of the route and the places as pins (A, B, numbered stops, dots). @param {MapParams} p */
export function pinsOf(p) {
  /** @type {{ lat: number, lon: number, label?: string, kind: 'from' | 'to' | 'via' | 'place', mark: string }[]} */
  const pins = []
  if (p.route !== undefined) {
    pins.push({ ...p.route.from, kind: 'from', mark: 'A' })
    p.route.via.forEach((v, i) => {
      pins.push({ ...v, kind: 'via', mark: String(i + 1) })
    })
    pins.push({ ...p.route.to, kind: 'to', mark: 'B' })
  }
  for (const place of p.places) pins.push({ ...place, kind: 'place', mark: '' })
  return pins
}
