/**
 * `@keith/tool-weather`: the reference `tool` plugin. It shows every mechanism once:
 * a tool with a UI card (`weather.current`), an `onAction` Refresh button, a service (`weather`),
 * an event (`weather.alert_raised`), plugin data (`ctx.data`) and deliveries on `person.arrived`.
 *
 * On arrival, with `homeCity` set, it feeds the briefing two separate items so their urgency can
 * differ: the day's forecast (`low`, once per person per local day at the home city, remembered in
 * `ctx.data` under `forecast:<personId>` so a restart doesn't repeat it) and a rain alert (`normal`,
 * when rain is likely in the next hours).
 */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { clockTime, dailyForecastText, nextRain } from './card.ts'
import { createOpenMeteo, type OpenMeteoOptions } from './open-meteo.ts'
import type { WeatherService } from './service.ts'
import { createCurrentWeatherTool } from './tool.ts'

export { dailyForecastText, nextRain, RAIN_LOOKAHEAD_HOURS, weatherResult } from './card.ts'
export {
  createOpenMeteo,
  describeWeatherCode,
  type FetchLike,
  isRainLikely,
  OPEN_METEO_FORECAST_URL,
  OPEN_METEO_GEOCODING_URL,
  type OpenMeteoOptions,
} from './open-meteo.ts'
export type * from './service.ts'

export const weatherConfig = z.object({
  /** When set, arriving people are told about rain here in the next hours. */
  homeCity: z.string().min(1).optional(),
  units: z.enum(['metric', 'imperial']).default('metric'),
  /** With `homeCity`: on a person's first arrival of the local day, deliver today's forecast (`low`). */
  dailyForecast: z.boolean().default(true),
})

/** The `ctx.data` key holding the last local date (`YYYY-MM-DD`) a person got the daily forecast. */
export const forecastDateKey = (personId: string): string => `forecast:${personId}`

export const WeatherAlertRaisedSchema = z.object({
  city: z.string(),
  condition: z.literal('rain'),
  at: z.string(),
  timezone: z.string(),
  precipitationProbability: z.number().nullable(),
})

/** Builds the plugin. Tests pass a replaying `fetch`; the default export uses the global one. */
export function createWeatherPlugin(opts: OpenMeteoOptions = {}) {
  const source = createOpenMeteo(opts)
  return definePlugin({
    id: '@keith/tool-weather',
    namespace: 'weather',
    version: '0.0.0',
    kind: 'tool',
    config: weatherConfig,
    setup(ctx) {
      const { homeCity, units, dailyForecast } = ctx.config
      const weather: WeatherService = {
        forecast: (city, o) => source.forecast(city, units, o?.signal),
      }
      ctx.services.provide('weather', weather)
      ctx.events.define('weather.alert_raised', WeatherAlertRaisedSchema)
      ctx.tools.register(createCurrentWeatherTool(weather))

      ctx.events.on('person.arrived', async (e) => {
        if (homeCity === undefined) return
        const { personId } = e.data
        const forecast = await weather.forecast(homeCity).catch((error: unknown) => {
          ctx.log.warn('arrival forecast failed', { city: homeCity, error: String(error) })
          return undefined
        })
        if (!forecast) return

        // The day's forecast: once per person per local day (the date is the place's, from the source).
        const today = forecast.today
        if (dailyForecast && today) {
          const key = forecastDateKey(personId)
          if ((await ctx.data.get<string>(key)) !== today.date) {
            await ctx.deliveries.enqueue({
              personId,
              text: dailyForecastText(forecast.city, today),
              urgency: 'low',
            })
            await ctx.data.set(key, today.date)
          }
        }

        const rain = nextRain(forecast)
        if (!rain) return
        const chance =
          rain.precipitationProbability === null ? '' : ` (${rain.precipitationProbability}% chance)`
        await ctx.deliveries.enqueue({
          personId,
          text: `Rain expected in ${forecast.city} around ${clockTime(rain.time)}${chance}.`,
          urgency: 'normal',
        })
        ctx.events.emit('weather.alert_raised', {
          city: forecast.city,
          condition: 'rain',
          at: rain.time,
          timezone: forecast.timezone,
          precipitationProbability: rain.precipitationProbability,
        })
      })
    },
  })
}

export default createWeatherPlugin()
