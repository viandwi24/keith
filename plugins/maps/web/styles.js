// The base map styles of the map window: where each one's tiles come from (through the core's plugin net route), how deep it goes, and
// its credit. Pure: the globe (globe.js) turns a style into imagery layers.

import { project, TILE } from './tiles.js'

const OSM_CREDIT = '© OpenStreetMap contributors'
// Esri's Canvas basemaps answer without a key (CARTO's basemaps started asking for one in 2026); their labels are a separate
// transparent layer, also drawn over the satellite and night styles.
const ESRI = 'https://services.arcgisonline.com'
const ESRI_CREDIT = 'Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community'
/** @param {string} name */
const esri = (name) => ({
  origin: ESRI,
  path: `/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`,
  maxZoom: 16,
})

/**
 * @typedef {{ origin: string, path: string, maxZoom: number }} TileSource `path` is a template under the origin: `{z}`, `{x}`, `{y}`
 * @typedef {{ label: string, base: TileSource, labels?: TileSource, credit: string, short: string, dark: boolean,
 *   tone?: { brightness?: number, saturation?: number, contrast?: number } }} MapStyle
 */

/**
 * The styles. Each origin is in the window's `network` (the core's net route allows only those hosts); `maxZoom` is the deepest level
 * the source draws (the globe scales that level past it); `labels` is a place-name layer drawn over the base (Satellite); `credit` is
 * the full attribution (shown on ⓘ) and `short` the line always on the map. `dark` says whether the map reads dark: the route line and
 * the labels pick their contrast from it.
 * @type {Record<string, MapStyle>}
 */
export const STYLES = {
  dark: {
    label: 'Dark',
    base: esri('World_Dark_Gray_Base'),
    labels: esri('World_Dark_Gray_Reference'),
    credit: ESRI_CREDIT,
    short: '© Esri · OpenStreetMap',
    dark: true,
  },
  satellite: {
    label: 'Satellite',
    base: {
      origin: 'https://tiles.maps.eox.at',
      path: '/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
      maxZoom: 15,
    },
    labels: esri('World_Dark_Gray_Reference'),
    credit:
      'Sentinel-2 cloudless (s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) · labels © Esri, © OpenStreetMap contributors',
    short: '© EOX Sentinel-2 · Esri',
    dark: true,
  },
  night: {
    label: 'Night lights',
    base: {
      origin: 'https://gibs.earthdata.nasa.gov',
      path: '/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      maxZoom: 8,
    },
    labels: esri('World_Dark_Gray_Reference'),
    credit:
      'Black Marble 2016, NASA Earth Observatory / GIBS · labels © Esri, © OpenStreetMap contributors',
    short: '© NASA GIBS · Esri',
    dark: true,
  },
  standard: {
    label: 'Standard',
    base: { origin: 'https://tile.openstreetmap.org', path: '/{z}/{x}/{y}.png', maxZoom: 19 },
    credit: OSM_CREDIT,
    short: '© OpenStreetMap',
    dark: false,
  },
  mono: {
    label: 'Mono',
    base: esri('World_Light_Gray_Base'),
    labels: esri('World_Light_Gray_Reference'),
    credit: ESRI_CREDIT,
    short: '© Esri · OpenStreetMap',
    dark: false,
  },
  topo: {
    label: 'Terrain',
    base: { origin: 'https://a.tile.opentopomap.org', path: '/{z}/{x}/{y}.png', maxZoom: 17 },
    credit: `${OSM_CREDIT}, SRTM · style © OpenTopoMap (CC-BY-SA)`,
    short: '© OpenStreetMap · OpenTopoMap',
    dark: false,
  },
  humanitarian: {
    label: 'Humanitarian',
    base: { origin: 'https://a.tile.openstreetmap.fr', path: '/hot/{z}/{x}/{y}.png', maxZoom: 19 },
    credit: `${OSM_CREDIT} · style HOT, hosted by OSM France`,
    short: '© OpenStreetMap',
    dark: false,
  },
  cycle: {
    label: 'Cycling',
    base: {
      origin: 'https://a.tile-cyclosm.openstreetmap.fr',
      path: '/cyclosm/{z}/{x}/{y}.png',
      maxZoom: 19,
    },
    credit: `${OSM_CREDIT} · style CyclOSM`,
    short: '© OpenStreetMap · CyclOSM',
    dark: false,
  },
}
export const DEFAULT_STYLE = 'dark'
/** @param {unknown} name @returns {string} a known style name, else the default (`dark`) */
export const styleName = (name) =>
  typeof name === 'string' && Object.hasOwn(STYLES, name) ? name : DEFAULT_STYLE
/** @param {unknown} name @returns {MapStyle} */
export const styleOf = (name) => /** @type {MapStyle} */ (STYLES[styleName(name)])

/**
 * A source's tile template through the core's plugin net route (`/plugins/maps/net/<host>/…`, relative to this page at
 * `/plugins/maps/web/`): the core fetches tiles with Keith's User-Agent, a few at a time, and caches them, as the OSM tile policy asks.
 * @param {TileSource} source
 */
export const templateOf = (source) => `../net/${new URL(source.origin).host}${source.path}`

/**
 * The URL of one tile of a source.
 * @param {TileSource} source @param {number} z @param {number} x @param {number} y
 */
export const tileUrl = (source, z, x, y) =>
  templateOf(source).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))

/**
 * The tile under a point, a little zoomed out, in a style: the preview of that style in the picker.
 * @param {number} lat @param {number} lon @param {number} zoom @param {string} style
 */
export function previewUrl(lat, lon, zoom, style) {
  const base = styleOf(style).base
  const z = Math.max(3, Math.min(Math.round(zoom) - 1, base.maxZoom))
  const p = project(lat, lon, z)
  const n = 2 ** z
  return tileUrl(base, z, ((Math.floor(p.x / TILE) % n) + n) % n, Math.floor(p.y / TILE))
}

/** Every origin the styles load tiles from (the window's `network` must hold them all). */
export const STYLE_ORIGINS = [
  ...new Set(
    Object.values(STYLES).flatMap((s) => [s.base.origin, ...(s.labels ? [s.labels.origin] : [])]),
  ),
]
