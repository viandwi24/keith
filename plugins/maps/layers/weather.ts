// Weather: the conditions now on a grid over the view from Open-Meteo (temperature, wind with its direction, the weather code), the air
// quality on the same grid (US AQI and PM2.5 from the CAMS model), and the global precipitation rate from NASA GIBS (GPM IMERG tiles,
// drawn as a raster by the window through the core's net route).
import type { Upstream } from '../upstream.ts'
import { type Bbox, type Feature, finite, type Provider, r5 } from './types.ts'

export const OPEN_METEO = 'https://api.open-meteo.com'
export const AIR_QUALITY = 'https://air-quality-api.open-meteo.com'
export const GIBS = 'https://gibs.earthdata.nasa.gov'

const COLS = 6
const ROWS = 4
const WEATHER_MS = 15 * 60_000
const AIR_MS = 30 * 60_000

/** WMO weather codes, as Open-Meteo documents them. */
const WMO: Record<number, string> = {
  0: 'clear',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'dense drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'rain showers',
  81: 'rain showers',
  82: 'violent showers',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm, hail',
  99: 'thunderstorm, hail',
}

export const weatherText = (code: number): string => WMO[code] ?? `code ${code}`

/** Grid points over a bbox: cell centres, rounded to 0.01° so near views share a cache entry. */
export function gridOf(b: Bbox, cols = COLS, rows = ROWS): { lat: number; lon: number }[] {
  const [s, n, w, e] = b
  const span = w <= e ? e - w : e + 360 - w
  const out: { lat: number; lon: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = s + ((r + 0.5) * (n - s)) / rows
      const lon = ((w + ((c + 0.5) * span) / cols + 540) % 360) - 180
      out.push({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 })
    }
  }
  return out
}

const listOf = (points: { lat: number; lon: number }[]) =>
  `latitude=${points.map((p) => p.lat).join(',')}&longitude=${points.map((p) => p.lon).join(',')}`

/** Open-Meteo answers one object for one place and an array for several. */
const answersOf = (body: unknown): Record<string, unknown>[] =>
  (Array.isArray(body) ? body : [body]).filter(
    (o): o is Record<string, unknown> => typeof o === 'object' && o !== null,
  )

export function weatherFeatures(body: unknown, points: { lat: number; lon: number }[]): Feature[] {
  const out: Feature[] = []
  answersOf(body).forEach((a, i) => {
    const cur = (a.current ?? {}) as Record<string, unknown>
    const p = points[i]
    const temp = cur.temperature_2m
    if (p === undefined || !finite(temp)) return
    const code = finite(cur.weather_code) ? cur.weather_code : undefined
    const wind = finite(cur.wind_speed_10m) ? cur.wind_speed_10m : undefined
    const dir = finite(cur.wind_direction_10m) ? cur.wind_direction_10m : undefined
    const f: Feature = {
      id: `wx:${p.lat},${p.lon}`,
      lat: r5(p.lat),
      lon: r5(p.lon),
      label: `${Math.round(temp)}°`,
      kind: code === undefined ? 'weather' : weatherText(code),
      value: temp,
      info: {
        Temperature: `${temp.toFixed(1)} °C`,
        ...(code === undefined ? {} : { Sky: weatherText(code) }),
        ...(wind === undefined
          ? {}
          : {
              Wind: `${Math.round(wind)} km/h${dir === undefined ? '' : ` from ${Math.round(dir)}°`}`,
            }),
        ...(finite(cur.precipitation) ? { Rain: `${cur.precipitation} mm` } : {}),
        ...(finite(cur.relative_humidity_2m) ? { Humidity: `${cur.relative_humidity_2m}%` } : {}),
      },
    }
    // the arrow points where the wind blows to
    if (dir !== undefined) f.heading = (dir + 180) % 360
    out.push(f)
  })
  return out
}

export function airFeatures(body: unknown, points: { lat: number; lon: number }[]): Feature[] {
  const out: Feature[] = []
  answersOf(body).forEach((a, i) => {
    const cur = (a.current ?? {}) as Record<string, unknown>
    const p = points[i]
    const aqi = cur.us_aqi
    if (p === undefined || !finite(aqi)) return
    out.push({
      id: `aq:${p.lat},${p.lon}`,
      lat: r5(p.lat),
      lon: r5(p.lon),
      label: `AQI ${Math.round(aqi)}`,
      kind: aqiBand(aqi),
      value: aqi,
      info: {
        'US AQI': Math.round(aqi),
        Level: aqiBand(aqi),
        ...(finite(cur.pm2_5) ? { 'PM2.5': `${cur.pm2_5.toFixed(1)} µg/m³` } : {}),
        ...(finite(cur.pm10) ? { PM10: `${cur.pm10.toFixed(1)} µg/m³` } : {}),
      },
    })
  })
  return out
}

export function aqiBand(aqi: number): string {
  if (aqi <= 50) return 'good'
  if (aqi <= 100) return 'moderate'
  if (aqi <= 150) return 'unhealthy for some'
  if (aqi <= 200) return 'unhealthy'
  if (aqi <= 300) return 'very unhealthy'
  return 'hazardous'
}

/** A small cache by URL: the same view asked twice within `ms` costs one request. */
function cached(ms: number) {
  const kept = new Map<string, { at: number; body: unknown }>()
  return async (url: string, now: number, load: () => Promise<unknown>) => {
    const hit = kept.get(url)
    if (hit !== undefined && now - hit.at < ms) return hit.body
    const body = await load()
    if (kept.size > 64) kept.clear()
    kept.set(url, { at: now, body })
    return body
  }
}

export function weatherProvider(up: Upstream): Provider {
  const cache = cached(WEATHER_MS)
  return {
    async fetch(q) {
      const points = gridOf(q.bbox)
      const url = `${OPEN_METEO}/v1/forecast?${listOf(points)}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m`
      const body = await cache(url, q.now, () =>
        up.json(url, { signal: q.signal, timeoutMs: 15_000 }),
      )
      return { features: weatherFeatures(body, points) }
    },
  }
}

export function airProvider(up: Upstream): Provider {
  const cache = cached(AIR_MS)
  return {
    async fetch(q) {
      const points = gridOf(q.bbox)
      const url = `${AIR_QUALITY}/v1/air-quality?${listOf(points)}&current=us_aqi,pm2_5,pm10`
      const body = await cache(url, q.now, () =>
        up.json(url, { signal: q.signal, timeoutMs: 15_000 }),
      )
      return { features: airFeatures(body, points) }
    },
  }
}

/**
 * GIBS IMERG tiles of a day: the latest hours are not published yet (404) and `default` is never cached, so the day before today
 * (UTC) is asked, which is always complete.
 */
export function rainTemplate(now: number): string {
  const day = new Date(now - 86_400_000).toISOString().slice(0, 10)
  return `../net/gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/${day}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`
}

export function rainProvider(): Provider {
  return {
    async fetch(q) {
      return {
        features: [],
        raster: { template: rainTemplate(q.now), maxZoom: 6, alpha: 0.75 },
        note: 'NASA IMERG of yesterday (UTC)',
      }
    },
  }
}
