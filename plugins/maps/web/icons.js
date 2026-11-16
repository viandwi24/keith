// Icons of the data layers, drawn once per glyph and colour on a canvas (the engine takes a canvas as a billboard image; nothing is
// fetched, so the page needs no image host for them).

/** @type {Map<string, HTMLCanvasElement>} */
const cache = new Map()

/**
 * A round badge with a glyph: the icon of a point (a camera, a station, a quake). `size` is CSS pixels; the canvas is drawn at twice
 * that for sharp edges.
 * @param {string} glyph @param {string} color @param {number} [size]
 */
export function badgeIcon(glyph, color, size = 22) {
  const key = `b:${glyph}:${color}:${size}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const c = document.createElement('canvas')
  const s = size * 2
  c.width = s
  c.height = s
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))
  g.beginPath()
  g.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2)
  g.fillStyle = 'rgba(11, 11, 11, 0.82)'
  g.fill()
  g.lineWidth = 3
  g.strokeStyle = color
  g.stroke()
  g.fillStyle = color
  g.font = `${Math.round(s * 0.5)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(glyph, s / 2, s / 2 + 1)
  cache.set(key, c)
  return c
}

/**
 * An arrow pointing up (the engine turns it by the heading): an aircraft, a ship, a bus.
 * @param {string} color @param {number} [size]
 */
export function arrowIcon(color, size = 20) {
  const key = `a:${color}:${size}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const c = document.createElement('canvas')
  const s = size * 2
  c.width = s
  c.height = s
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))
  g.beginPath()
  g.moveTo(s / 2, 2)
  g.lineTo(s - 6, s - 4)
  g.lineTo(s / 2, s * 0.68)
  g.lineTo(6, s - 4)
  g.closePath()
  g.fillStyle = color
  g.shadowColor = 'rgba(0, 0, 0, 0.8)'
  g.shadowBlur = 4
  g.fill()
  cache.set(key, c)
  return c
}

/**
 * A soft dot whose size says how strong it is (a quake's magnitude, an AQI reading).
 * @param {string} color @param {number} size
 */
export function dotIcon(color, size) {
  const px = Math.max(6, Math.min(48, Math.round(size)))
  const key = `d:${color}:${px}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const c = document.createElement('canvas')
  const s = px * 2
  c.width = s
  c.height = s
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grad.addColorStop(0, color)
  grad.addColorStop(0.45, color)
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  g.fillStyle = grad
  g.fillRect(0, 0, s, s)
  g.beginPath()
  g.arc(s / 2, s / 2, Math.max(2, s * 0.14), 0, Math.PI * 2)
  g.fillStyle = '#ffffff'
  g.fill()
  cache.set(key, c)
  return c
}

/** The colour of a US AQI reading (the EPA bands). @param {number} aqi */
export function aqiColor(aqi) {
  if (aqi <= 50) return '#22c55e'
  if (aqi <= 100) return '#eab308'
  if (aqi <= 150) return '#f97316'
  if (aqi <= 200) return '#ef4444'
  if (aqi <= 300) return '#a855f7'
  return '#7f1d1d'
}

/** The colour of a temperature in °C, cold blue to hot red. @param {number} t */
export function tempColor(t) {
  if (t <= 0) return '#93c5fd'
  if (t <= 10) return '#7dd3fc'
  if (t <= 20) return '#86efac'
  if (t <= 26) return '#fde047'
  if (t <= 32) return '#fb923c'
  return '#f87171'
}
