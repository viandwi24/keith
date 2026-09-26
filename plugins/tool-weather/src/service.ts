/**
 * Type-only entry (`@keith/tool-weather/service`). Consumers add this package as a devDependency
 * and write `import type {} from '@keith/tool-weather/service'` to get the `weather` service and
 * the `weather.alert_raised` event typed (plugin-system.md#services-i-need-something-done-or-some-data).
 * No runtime code lives here.
 */

export type WeatherUnits = 'metric' | 'imperial'

/** Display labels for the units, e.g. `°C`, `km/h`, `mm` (metric) or `°F`, `mph`, `in` (imperial). */
export interface WeatherUnitLabels {
  temperature: string
  windSpeed: string
  precipitation: string
}

export interface CurrentWeather {
  /** Local time at the place, `YYYY-MM-DDTHH:MM`. */
  time: string
  temperature: number
  apparentTemperature: number
  /** Relative humidity in percent. */
  humidity: number
  precipitation: number
  windSpeed: number
  /** WMO weather interpretation code. */
  weatherCode: number
  /** Plain-English description of `weatherCode`, e.g. `slight rain`. */
  summary: string
}

export interface HourlyWeather {
  /** Local time at the place, `YYYY-MM-DDTHH:MM`. */
  time: string
  /** Percent, or null when the model has none for that hour. */
  precipitationProbability: number | null
  precipitation: number
  weatherCode: number
  summary: string
  /** True when rain is likely in this hour (rain-like weather code or probability ≥ 50 %). */
  rainLikely: boolean
}

export interface Forecast {
  /** Resolved place name, e.g. `Surabaya`. */
  city: string
  country: string | null
  /** IANA time zone of the place. */
  timezone: string
  units: WeatherUnits
  unitLabels: WeatherUnitLabels
  current: CurrentWeather
  /** The next hours, starting with the current one. */
  hourly: HourlyWeather[]
}

export interface WeatherService {
  /** Throws `NOT_FOUND` for an unknown place and `PROVIDER_ERROR` when the weather source fails. */
  forecast(city: string, opts?: { signal?: AbortSignal }): Promise<Forecast>
}

/** Payload of `weather.alert_raised`: rain is likely soon at the configured home city. */
export interface WeatherAlertRaised {
  city: string
  condition: 'rain'
  /** Local time of the first rainy hour, `YYYY-MM-DDTHH:MM`. */
  at: string
  timezone: string
  precipitationProbability: number | null
}

declare module '@keith/sdk' {
  interface ServiceMap {
    weather: WeatherService
  }
  interface EventMap {
    'weather.alert_raised': WeatherAlertRaised
  }
}
