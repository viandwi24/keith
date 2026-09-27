/** Turns a `Forecast` into what the model reads (`content`) and what humans see (a `card` block). */
import type { CardBlock } from '@keith/protocol'
import type { ToolResult } from '@keith/sdk'
import type { Forecast, HourlyWeather } from './service.ts'

/** How far ahead "rain soon" looks, in hours, counting the current hour. */
export const RAIN_LOOKAHEAD_HOURS = 6

export const CARD_BLOCK_ID = 'weather'
export const DETAILS_BLOCK_ID = 'weather_details'
export const ACTIONS_BLOCK_ID = 'weather_actions'
export const REFRESH_ACTION_ID = 'refresh'

/** The first hour within `RAIN_LOOKAHEAD_HOURS` where rain is likely, if any. */
export function nextRain(f: Forecast): HourlyWeather | undefined {
  return f.hourly.slice(0, RAIN_LOOKAHEAD_HOURS).find((h) => h.rainLikely)
}

/** `2026-09-27T16:00` → `16:00`. */
export function clockTime(localTime: string): string {
  return localTime.slice(11, 16)
}

function place(f: Forecast): string {
  return f.country ? `${f.city}, ${f.country}` : f.city
}

function rainLine(f: Forecast): string {
  const rain = nextRain(f)
  if (!rain) return `No rain expected in the next ${RAIN_LOOKAHEAD_HOURS} hours.`
  const chance = rain.precipitationProbability === null ? '' : ` (${rain.precipitationProbability}% chance)`
  return `Rain expected around ${clockTime(rain.time)}${chance}.`
}

/** The card for `weather.current` and its refresh. `query` is what the Refresh button fetches again. */
export function weatherResult(f: Forecast, query: string): ToolResult & { ui: CardBlock } {
  const u = f.unitLabels
  const c = f.current
  const rain = rainLine(f)
  return {
    content:
      `${place(f)} at ${clockTime(c.time)} local time: ${c.temperature}${u.temperature} ` +
      `(feels like ${c.apparentTemperature}${u.temperature}), ${c.summary}, humidity ${c.humidity}%, ` +
      `wind ${c.windSpeed} ${u.windSpeed}. ${rain}`,
    ui: {
      type: 'card',
      id: CARD_BLOCK_ID,
      title: f.city,
      subtitle: `${f.country ? `${f.country}, ` : ''}${clockTime(c.time)} local time`,
      body: `**${c.temperature}${u.temperature}**, ${c.summary}. ${rain}`,
      footer: 'Weather data by Open-Meteo.com',
      children: [
        {
          type: 'keyValue',
          id: DETAILS_BLOCK_ID,
          pairs: [
            { key: 'Feels like', value: `${c.apparentTemperature}${u.temperature}` },
            { key: 'Humidity', value: `${c.humidity}%` },
            { key: 'Wind', value: `${c.windSpeed} ${u.windSpeed}` },
            { key: 'Precipitation', value: `${c.precipitation} ${u.precipitation}` },
          ],
        },
        {
          type: 'actions',
          id: ACTIONS_BLOCK_ID,
          actions: [{ id: REFRESH_ACTION_ID, label: 'Refresh', style: 'secondary', value: { city: query } }],
        },
      ],
    },
  }
}
