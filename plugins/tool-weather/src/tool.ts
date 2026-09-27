import { defineTool, KeithError } from '@keith/sdk'
import { z } from 'zod'
import { ACTIONS_BLOCK_ID, REFRESH_ACTION_ID, weatherResult } from './card.ts'
import type { WeatherService } from './service.ts'

const RefreshValue = z.object({ city: z.string().min(1) })

/** `weather.current`: current weather as text for the model and a card for humans. */
export function createCurrentWeatherTool(weather: WeatherService) {
  return defineTool({
    name: 'weather.current',
    description:
      'Current weather and rain in the next hours for a city. Use when the person asks about the weather now or today.',
    input: z.object({ city: z.string().min(1).describe('City name, e.g. "Surabaya" or "Berlin"') }),
    minTier: 'member',
    timeoutMs: 20_000,
    async run(input, t) {
      return weatherResult(await weather.forecast(input.city, { signal: t.signal }), input.city)
    },
    /** The card's Refresh button fetches the same city again and shows an updated card. */
    async onAction(action, t) {
      if (action.blockId !== ACTIONS_BLOCK_ID || action.actionId !== REFRESH_ACTION_ID) return undefined
      const value = RefreshValue.safeParse(action.value)
      if (!value.success) {
        throw new KeithError('TOOL_INPUT_INVALID', 'refresh action carries no city', { cause: value.error })
      }
      return weatherResult(await weather.forecast(value.data.city, { signal: t.signal }), value.data.city)
    },
  })
}
