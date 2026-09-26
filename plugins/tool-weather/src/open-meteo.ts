/**
 * Open-Meteo client (keyless, free for non-commercial use).
 *
 * Docs read on 2026-09-26:
 * - Forecast API: https://open-meteo.com/en/docs (`GET https://api.open-meteo.com/v1/forecast`)
 * - Geocoding API: https://open-meteo.com/en/docs/geocoding-api
 *   (`GET https://geocoding-api.open-meteo.com/v1/search`)
 *
 * `fetch` is injected so tests replay fixtures and never touch the network (R-13).
 */
import { KeithError } from '@keith/sdk'
import { z } from 'zod'
import type { Forecast, HourlyWeather, WeatherUnitLabels, WeatherUnits } from './service.ts'

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
export const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'

/** How many hours of hourly data a forecast holds, starting with the current hour. */
export const FORECAST_HOURS = 12

/** The subset of `fetch` the client uses. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type OpenMeteoOptions = {
  fetch?: FetchLike | undefined
  forecastUrl?: string | undefined
  geocodingUrl?: string | undefined
}

/** WMO weather interpretation codes, as listed in the forecast API docs. */
const WMO_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
}

/** Drizzle, rain, rain showers and thunderstorms. */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99])

/** An hour counts as rainy at or above this precipitation probability (percent). */
export const RAIN_PROBABILITY_THRESHOLD = 50

export function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `unknown conditions (code ${code})`
}

export function isRainLikely(code: number, probability: number | null): boolean {
  return RAIN_CODES.has(code) || (probability !== null && probability >= RAIN_PROBABILITY_THRESHOLD)
}

const GeocodingResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
})

const ForecastResponse = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    apparent_temperature: z.number(),
    precipitation: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    precipitation_probability: z.array(z.number().nullable()),
    precipitation: z.array(z.number().nullable()),
    weather_code: z.array(z.number().nullable()),
  }),
})

const ErrorResponse = z.object({ reason: z.string() })

const UNIT_PARAMS: Record<WeatherUnits, Record<string, string>> = {
  metric: { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' },
  imperial: { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' },
}

const UNIT_LABELS: Record<WeatherUnits, WeatherUnitLabels> = {
  metric: { temperature: '°C', windSpeed: 'km/h', precipitation: 'mm' },
  imperial: { temperature: '°F', windSpeed: 'mph', precipitation: 'in' },
}

export type OpenMeteoClient = {
  forecast(city: string, units: WeatherUnits, signal?: AbortSignal): Promise<Forecast>
}

export function createOpenMeteo(opts: OpenMeteoOptions = {}): OpenMeteoClient {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const forecastUrl = opts.forecastUrl ?? OPEN_METEO_FORECAST_URL
  const geocodingUrl = opts.geocodingUrl ?? OPEN_METEO_GEOCODING_URL

  async function getJson<T>(url: string, schema: z.ZodType<T>, signal: AbortSignal | undefined): Promise<T> {
    let res: Response
    try {
      res = await doFetch(url, signal ? { signal } : {})
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw new KeithError('PROVIDER_ERROR', 'weather source unreachable', { cause })
    }
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      const reason = ErrorResponse.safeParse(body)
      throw new KeithError(
        'PROVIDER_ERROR',
        `weather source failed with HTTP ${res.status}${reason.success ? `: ${reason.data.reason}` : ''}`,
        { details: { status: res.status } },
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new KeithError('PROVIDER_ERROR', 'weather source returned an unexpected response', {
        cause: parsed.error,
      })
    }
    return parsed.data
  }

  return {
    async forecast(city, units, signal) {
      const query = city.trim()
      const geoParams = new URLSearchParams({ name: query, count: '1', language: 'en', format: 'json' })
      const geo = await getJson(`${geocodingUrl}?${geoParams}`, GeocodingResponse, signal)
      const place = geo.results?.[0]
      if (!place) {
        throw new KeithError('NOT_FOUND', `no place named '${query}' found`, { details: { city: query } })
      }

      const params = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current:
          'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        hourly: 'precipitation_probability,precipitation,weather_code',
        forecast_hours: String(FORECAST_HOURS),
        timezone: 'auto',
        ...UNIT_PARAMS[units],
      })
      const f = await getJson(`${forecastUrl}?${params}`, ForecastResponse, signal)

      const hourly: HourlyWeather[] = f.hourly.time.map((time, i) => {
        const probability = f.hourly.precipitation_probability[i] ?? null
        const code = f.hourly.weather_code[i] ?? 0
        return {
          time,
          precipitationProbability: probability,
          precipitation: f.hourly.precipitation[i] ?? 0,
          weatherCode: code,
          summary: describeWeatherCode(code),
          rainLikely: isRainLikely(code, probability),
        }
      })
      const currentHour = `${f.current.time.slice(0, 13)}:00`

      return {
        city: place.name,
        country: place.country ?? null,
        timezone: f.timezone,
        units,
        unitLabels: UNIT_LABELS[units],
        current: {
          time: f.current.time,
          temperature: f.current.temperature_2m,
          apparentTemperature: f.current.apparent_temperature,
          humidity: f.current.relative_humidity_2m,
          precipitation: f.current.precipitation,
          windSpeed: f.current.wind_speed_10m,
          weatherCode: f.current.weather_code,
          summary: describeWeatherCode(f.current.weather_code),
        },
        hourly: hourly.filter((h) => h.time >= currentHour),
      }
    },
  }
}
