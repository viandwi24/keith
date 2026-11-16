// The data layers on the globe: points with icons and labels, moving things (aircraft, ships, buses move on between answers by their
// speed and heading; satellites follow their propagated track), lines, and rasters (rain, recent imagery) on the ground. A click on a
// point picks it (map.js shows its card).

import { layerOf } from './catalog.js'
import { Cesium, hideBehindGlobe } from './globe.js'
import { aqiColor, arrowIcon, badgeIcon, dotIcon, tempColor } from './icons.js'

/**
 * @typedef {{ id: string, lat: number, lon: number, alt?: number, heading?: number, speed?: number, label?: string, kind?: string,
 *   size?: number, value?: number, info?: Record<string, string | number>, image?: string, stream?: string, link?: string,
 *   line?: [number, number][], track?: [number, number, number, number][], rect?: [number, number, number, number],
 *   at?: number }} Feature
 * @typedef {{ id: string, features: Feature[], raster?: { template: string, maxZoom: number, alpha?: number }, note?: string,
 *   error?: string, at?: number }} LayerAnswer
 */

/** Moving things are moved on by dead reckoning for at most this long after their fix. */
const MAX_COAST_S = 120
const EARTH_R = 6_371_000

/** How far (metres from the camera) each layer's labels show; others 600 km. @type {Record<string, number>} */
const LABEL_FAR_M = {
  satellites: 2.5e6,
  quakes: 4e6,
  cameras: 4e3,
  transit: 4e3,
  flights: 3e5,
  vessels: 6e4,
}

/**
 * The point `metres` from (`lat`, `lon`) along `heading` (degrees from north), on a sphere.
 * @param {number} lat @param {number} lon @param {number} heading @param {number} metres
 */
export function moveAlong(lat, lon, heading, metres) {
  const d = metres / EARTH_R
  const h = (heading * Math.PI) / 180
  const p1 = (lat * Math.PI) / 180
  const l1 = (lon * Math.PI) / 180
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(h))
  const l2 =
    l1 +
    Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return { lat: (p2 * 180) / Math.PI, lon: (((l2 * 180) / Math.PI + 540) % 360) - 180 }
}

/**
 * Where a tracked thing is at `t` (ms) from its samples `[t, lat, lon, alt]`: linear between the two around it, the end ones outside.
 * Longitude is unwrapped across the antimeridian.
 * @param {[number, number, number, number][]} track @param {number} t
 */
export function trackAt(track, t) {
  const first = track[0]
  if (first === undefined) return undefined
  if (t <= first[0] || track.length === 1) return { lat: first[1], lon: first[2], alt: first[3] }
  for (let i = 1; i < track.length; i++) {
    const b = /** @type {[number, number, number, number]} */ (track[i])
    if (t > b[0]) continue
    const a = /** @type {[number, number, number, number]} */ (track[i - 1])
    const f = (t - a[0]) / Math.max(1, b[0] - a[0])
    let dl = b[2] - a[2]
    if (dl > 180) dl -= 360
    if (dl < -180) dl += 360
    const lon = ((((a[2] + dl * f + 540) % 360) + 360) % 360) - 180
    return { lat: a[1] + (b[1] - a[1]) * f, lon, alt: a[3] + (b[3] - a[3]) * f }
  }
  const last = /** @type {[number, number, number, number]} */ (track[track.length - 1])
  return { lat: last[1], lon: last[2], alt: last[3] }
}

/** The icon of a feature of a layer. @param {string} layer @param {Feature} f */
function iconOf(layer, f) {
  const info = layerOf(layer)
  const color = info?.color ?? '#e5e7eb'
  if (layer === 'quakes') return dotIcon('#fb923c', 8 + (f.size ?? 3) * 5)
  if (layer === 'air' && f.value !== undefined) return dotIcon(aqiColor(f.value), 26)
  if (layer === 'weather' && f.value !== undefined) return badgeIcon('•', tempColor(f.value), 18)
  if (f.heading !== undefined && (info?.group === 'movement' || layer === 'receivers'))
    return arrowIcon(f.kind === 'military' ? '#f59e0b' : color, layer === 'transit' ? 14 : 18)
  return badgeIcon(info?.glyph ?? '•', color, layer === 'satellites' ? 16 : 22)
}

/** @param {import('./globe.js').Globe} globe */
export function createFeatures(globe) {
  const { scene } = globe
  /**
   * @type {Map<string, { billboards: import('cesium').BillboardCollection, labels: import('cesium').LabelCollection,
   *   lines: import('cesium').PolylineCollection, raster?: import('cesium').ImageryLayer, images: import('cesium').ImageryLayer[],
   *   moving: { f: Feature, b: import('cesium').Billboard, l?: import('cesium').Label, at: number }[] }>}
   */
  const shown = new Map()
  /** The template each raster layer was made from. @type {WeakMap<import('cesium').ImageryLayer, string>} */
  const rasterKeys = new WeakMap()
  /** The picked feature's line (an orbit or a trail). @type {import('cesium').Polyline | undefined} */
  let pickedLine
  const pickedLines = new Cesium.PolylineCollection()
  scene.primitives.add(pickedLines)
  hideBehindGlobe(scene, function* () {
    for (const s of shown.values()) yield* [s.billboards, s.labels]
  })

  /** @param {string} layer */
  function clear(layer) {
    const s = shown.get(layer)
    if (s === undefined) return
    scene.primitives.remove(s.billboards)
    scene.primitives.remove(s.labels)
    scene.primitives.remove(s.lines)
    if (s.raster !== undefined) scene.imageryLayers.remove(s.raster, true)
    for (const i of s.images) scene.imageryLayers.remove(i, true)
    shown.delete(layer)
    scene.requestRender()
  }

  /** @param {LayerAnswer} answer */
  function set(answer) {
    const layer = answer.id
    const keep = shown.get(layer)
    const rasterKey = answer.raster?.template
    // a raster that did not change stays (no flash of an empty layer while its tiles reload)
    const oldRaster = keep?.raster
    const sameRaster =
      oldRaster !== undefined && rasterKey !== undefined && rasterKeys.get(oldRaster) === rasterKey
    if (keep !== undefined) {
      scene.primitives.remove(keep.billboards)
      scene.primitives.remove(keep.labels)
      scene.primitives.remove(keep.lines)
      for (const i of keep.images) scene.imageryLayers.remove(i, true)
      if (!sameRaster && oldRaster !== undefined) scene.imageryLayers.remove(oldRaster, true)
    }
    const billboards = new Cesium.BillboardCollection({ scene })
    const labels = new Cesium.LabelCollection({ scene })
    const lines = new Cesium.PolylineCollection()
    scene.primitives.add(lines)
    scene.primitives.add(billboards)
    scene.primitives.add(labels)
    /** @type {{ f: Feature, b: import('cesium').Billboard, l?: import('cesium').Label, at: number }[]} */
    const moving = []
    const color = Cesium.Color.fromCssColorString(layerOf(layer)?.color ?? '#e5e7eb')
    const now = Date.now()
    // labels only where they can be read: dense layers (a city's cameras, its buses) name things from street level only
    const labelFar = LABEL_FAR_M[layer] ?? 6e5
    for (const f of answer.features) {
      const at =
        f.track === undefined ? { lat: f.lat, lon: f.lon, alt: f.alt ?? 0 } : trackAt(f.track, now)
      if (at === undefined) continue
      const position = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt ?? 0)
      const b = billboards.add({
        position,
        image: iconOf(layer, f),
        id: { layer, feature: f },
        scale: 0.5,
        scaleByDistance: new Cesium.NearFarScalar(2e3, 1.15, 2e7, 0.55),
        ...(f.heading === undefined
          ? {}
          : { rotation: -Cesium.Math.toRadians(f.heading), alignedAxis: Cesium.Cartesian3.UNIT_Z }),
        disableDepthTestDistance: layer === 'satellites' ? 0 : Number.POSITIVE_INFINITY,
      })
      /** @type {import('cesium').Label | undefined} */
      let l
      if (f.label !== undefined && f.label !== '') {
        l = labels.add({
          position,
          text: f.label,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(12, -10),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, labelFar),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { layer, feature: f },
        })
      }
      if (
        f.track !== undefined ||
        (f.speed !== undefined && f.heading !== undefined && f.speed > 0.5)
      )
        moving.push(l === undefined ? { f, b, at: f.at ?? now } : { f, b, l, at: f.at ?? now })
      if (
        f.line !== undefined &&
        f.line.length > 1 &&
        f.track === undefined &&
        layer !== 'flights'
      ) {
        lines.add({
          positions: Cesium.Cartesian3.fromDegreesArray(f.line.flatMap(([la, lo]) => [lo, la])),
          width: 2,
          material: Cesium.Material.fromType('Color', { color: color.withAlpha(0.7) }),
        })
      }
    }
    /** @type {import('cesium').ImageryLayer[]} */
    const images = []
    for (const f of answer.features) {
      if (f.rect === undefined || f.image === undefined) continue
      const [s, n, w, e] = f.rect
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: f.image,
        tilingScheme: new Cesium.GeographicTilingScheme({
          rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n),
          numberOfLevelZeroTilesX: 1,
          numberOfLevelZeroTilesY: 1,
        }),
        rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n),
        maximumLevel: 0,
        tileWidth: 512,
        tileHeight: 512,
      })
      const imageLayer = scene.imageryLayers.addImageryProvider(provider)
      imageLayer.alpha = 0.92
      images.push(imageLayer)
    }
    /** @type {import('cesium').ImageryLayer | undefined} */
    let raster = sameRaster ? oldRaster : undefined
    if (answer.raster !== undefined && !sameRaster) {
      raster = scene.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: answer.raster.template,
          maximumLevel: answer.raster.maxZoom,
        }),
      )
      raster.alpha = answer.raster.alpha ?? 0.7
      rasterKeys.set(raster, answer.raster.template)
    }
    const entry = { billboards, labels, lines, images, moving }
    shown.set(layer, raster === undefined ? entry : { ...entry, raster })
    scene.requestRender()
  }

  /** Moves the moving things to where they are now; true when something moved. */
  function tick() {
    const now = Date.now()
    let moved = false
    for (const s of shown.values()) {
      for (const m of s.moving) {
        let p
        if (m.f.track !== undefined) {
          p = trackAt(m.f.track, now)
        } else if (m.f.speed !== undefined && m.f.heading !== undefined) {
          const dt = Math.min(MAX_COAST_S, Math.max(0, (now - m.at) / 1000))
          const q = moveAlong(m.f.lat, m.f.lon, m.f.heading, m.f.speed * dt)
          p = { ...q, alt: m.f.alt ?? 0 }
        }
        if (p === undefined) continue
        const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt ?? 0)
        m.b.position = position
        if (m.l !== undefined) m.l.position = position
        moved = true
      }
    }
    if (moved) scene.requestRender()
    return moved
  }

  /**
   * Draws the line of a picked feature (a satellite's orbit, an aircraft's trail), or clears it.
   * @param {string | undefined} layer @param {Feature | undefined} f
   */
  function pick(layer, f) {
    if (pickedLine !== undefined) pickedLines.remove(pickedLine)
    pickedLine = undefined
    if (layer !== undefined && f !== undefined) {
      const pts =
        f.track !== undefined
          ? f.track.map((t) => [t[1], t[2], t[3] ?? 0])
          : (f.line ?? []).map(([a, b]) => [a, b, f.alt ?? 0])
      if (pts.length > 1) {
        pickedLine = pickedLines.add({
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            pts.flatMap(([a, b, h]) => [b ?? 0, a ?? 0, h ?? 0]),
          ),
          width: 2,
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.fromCssColorString(layerOf(layer)?.color ?? '#ffffff').withAlpha(
              0.9,
            ),
          }),
        })
      }
    }
    scene.requestRender()
  }

  /**
   * Where a feature is now: along its track, moved on by its speed, or where its answer put it.
   * @param {string} layer @param {Feature} f
   */
  function positionOf(layer, f) {
    if (f.track !== undefined) return trackAt(f.track, Date.now()) ?? { lat: f.lat, lon: f.lon }
    const m = shown.get(layer)?.moving.find((x) => x.f === f)
    if (m === undefined || f.speed === undefined || f.heading === undefined)
      return { lat: f.lat, lon: f.lon }
    const dt = Math.min(MAX_COAST_S, Math.max(0, (Date.now() - m.at) / 1000))
    return moveAlong(f.lat, f.lon, f.heading, f.speed * dt)
  }

  /** The layer and feature under a canvas pixel. @param {number} x @param {number} y */
  function featureAt(x, y) {
    const hit = scene.pick(new Cesium.Cartesian2(x, y))
    const id = hit?.id
    if (
      typeof id === 'object' &&
      id !== null &&
      typeof id.layer === 'string' &&
      typeof id.feature === 'object'
    )
      return /** @type {{ layer: string, feature: Feature }} */ (id)
    return undefined
  }

  return {
    set,
    clear,
    tick,
    pick,
    featureAt,
    positionOf,
    /** The layers drawn now. */
    layers: () => [...shown.keys()],
    /** Whether any shown layer moves (the page then ticks once a second). */
    anyMoving: () => [...shown.values()].some((s) => s.moving.length > 0),
  }
}
