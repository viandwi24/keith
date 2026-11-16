// Web Mercator math of the map window (pure, no DOM): longitude and latitude to world pixels and back, the view that fits a set of
// points, and the camera height of a zoom level (the globe's camera speaks metres, the params speak Web Mercator zoom).

export const TILE = 256
export const MIN_ZOOM = 1
export const MAX_ZOOM = 19
/** Web Mercator stops here: the square world of the tiles. */
export const MAX_LAT = 85.0511287798066
/** Metres per pixel at zoom 0 on the equator (256 px tiles). */
export const EQUATOR_MPP = 156_543.033_92
/** The camera's field of view: Cesium's default, 60 degrees across the longer side of the canvas. */
export const FOV = Math.PI / 3

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** @param {number} zoom @returns {number} a zoom in 1..19, to 2 decimals (a fit lands between levels) */
export const clampZoom = (zoom) => clamp(Math.round(zoom * 100) / 100, MIN_ZOOM, MAX_ZOOM)

/** @param {number} zoom @returns {number} the world size in pixels at this zoom */
export const worldSize = (zoom) => TILE * 2 ** zoom

/** @param {number} lon @returns {number} the longitude in [-180, 180) */
export const wrapLon = (lon) => {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 && lon > 0 ? 180 : wrapped
}

/**
 * @param {number} lat @param {number} lon @param {number} zoom
 * @returns {{ x: number, y: number }} the world pixel of the point
 */
export function project(lat, lon, zoom) {
  const size = worldSize(zoom)
  const phi = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180
  const x = ((lon + 180) / 360) * size
  const y = (0.5 - Math.log((1 + Math.sin(phi)) / (1 - Math.sin(phi))) / (4 * Math.PI)) * size
  return { x, y }
}

/**
 * @param {number} x @param {number} y @param {number} zoom
 * @returns {{ lat: number, lon: number }} the point at a world pixel (longitude wrapped, latitude clamped)
 */
export function unproject(x, y, zoom) {
  const size = worldSize(zoom)
  const lon = wrapLon((x / size) * 360 - 180)
  const n = Math.PI - (2 * Math.PI * clamp(y, 0, size)) / size
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n))
  return { lat: clamp(lat, -MAX_LAT, MAX_LAT), lon }
}

/**
 * The centre and the deepest zoom (up to `maxZoom`, fractional) at which every point fits a `width` x `height` viewport with `pad`
 * pixels free on each side.
 * @param {{ lat: number, lon: number }[]} points @param {number} width @param {number} height
 * @param {number} [pad] @param {number} [maxZoom]
 * @returns {{ lat: number, lon: number, zoom: number } | undefined}
 */
export function fitView(points, width, height, pad = 40, maxZoom = 17) {
  if (points.length === 0) return undefined
  const ys = points.map((p) => project(p.lat, p.lon, 0))
  const x0 = Math.min(...ys.map((p) => p.x))
  const x1 = Math.max(...ys.map((p) => p.x))
  const y0 = Math.min(...ys.map((p) => p.y))
  const y1 = Math.max(...ys.map((p) => p.y))
  const w = Math.max(1, width - 2 * pad)
  const h = Math.max(1, height - 2 * pad)
  // the deepest zoom, between levels too (floored to 0.05), at which the box fits: 2^zoom * span <= room
  const fit = Math.log2(Math.min(w / Math.max(x1 - x0, 1e-12), h / Math.max(y1 - y0, 1e-12)))
  const zoom = clamp(Math.floor(fit * 20) / 20, MIN_ZOOM, maxZoom)
  const c = unproject((x0 + x1) / 2, (y0 + y1) / 2, 0)
  return { lat: c.lat, lon: c.lon, zoom }
}

/**
 * The point `dx`, `dy` screen pixels from (`lat`, `lon`) at `zoom`: the centre that puts a fitted box in the free room beside a panel.
 * @param {number} lat @param {number} lon @param {number} zoom @param {number} dx @param {number} dy
 */
export function offsetPoint(lat, lon, zoom, dx, dy) {
  const c = project(lat, lon, zoom)
  return unproject(c.x + dx, c.y + dy, zoom)
}

/** @param {number} v @returns {number} rounded to 6 decimals (about 10 cm) */
export const round6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * The camera height (metres above the ground, looking straight down) that shows the map at Web Mercator `zoom` on a canvas whose
 * longer side is `long` pixels: the metres a pixel covers there, times half the side, over the tangent of half the field of view.
 * @param {number} zoom @param {number} lat @param {number} long
 */
export function heightForZoom(zoom, lat, long) {
  const mpp = (EQUATOR_MPP * Math.cos((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180)) / 2 ** zoom
  return (mpp * Math.max(1, long)) / 2 / Math.tan(FOV / 2)
}

/** The zoom of a camera height, the inverse of `heightForZoom`, clamped to 1..19. @param {number} height @param {number} lat @param {number} long */
export function zoomForHeight(height, lat, long) {
  const mpp = (Math.max(1, height) * 2 * Math.tan(FOV / 2)) / Math.max(1, long)
  const cos = Math.cos((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180)
  return clampZoom(Math.log2((EQUATOR_MPP * cos) / mpp))
}

/** The projected (Web Mercator) metres a canvas `px` pixels wide spans at a zoom, the inverse of `zoomForSpan`. @param {number} zoom @param {number} px */
export const spanForZoom = (zoom, px) => (EQUATOR_MPP * Math.max(1, px)) / 2 ** zoom

/** The zoom of a 2D view whose canvas is `px` pixels wide and spans `metres` projected (Web Mercator) metres. @param {number} metres @param {number} px */
export function zoomForSpan(metres, px) {
  return clampZoom(Math.log2((EQUATOR_MPP * Math.max(1, px)) / Math.max(1, metres)))
}
