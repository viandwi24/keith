import { describe, expect, test } from 'bun:test'
import { type PersonDto, type PersonId, UiBlock, uiBlockToText } from '@keith/protocol'
import { isKeithError, type Tool, type ToolAction, type ToolRunContext } from '@keith/sdk'
import { type FakePluginContext, setupFakePlugin } from '@keith/sdk/testing'
import { createWeatherPlugin, type Forecast } from '../src/index.ts'
import { BAD_REQUEST, DRY, DRY_IMPERIAL, NO_PLACE, RAIN, type Replay, replay, SURABAYA } from './replay.ts'

const tony: PersonId = 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V31'
const person: PersonDto = { id: tony, name: 'Tony', tier: 'owner' }

async function load(r: Replay, config: unknown = {}) {
  const ctx = await setupFakePlugin(createWeatherPlugin({ fetch: r.fetch }), { config, start: true })
  const tool = ctx.recorded.tools[0]
  if (!tool) throw new Error('no tool registered')
  return { ctx, tool }
}

function runCtx(ctx: FakePluginContext<unknown>, signal = new AbortController().signal): ToolRunContext {
  return {
    person,
    participants: [person],
    threadId: null,
    taskId: null,
    signal,
    log: ctx.log,
    services: ctx.services,
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  )
}

function refresh(city: unknown, over: Partial<ToolAction> = {}): ToolAction {
  return {
    messageId: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
    blockId: 'weather_actions',
    actionId: 'refresh',
    value: { city },
    ...over,
  }
}

async function onAction(tool: Tool, action: ToolAction, t: ToolRunContext) {
  if (!tool.onAction) throw new Error('tool has no onAction')
  return tool.onAction(action, t)
}

describe('@keith/tool-weather registration', () => {
  test('registers exactly the tool, the service and the event schema', async () => {
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: DRY }))
    expect(ctx.plugin).toMatchObject({ id: '@keith/tool-weather', namespace: 'weather', kind: 'tool' })
    expect(ctx.recorded.tools.map((t) => t.name)).toEqual(['weather.current'])
    expect([...ctx.recorded.services.keys()]).toEqual(['weather'])
    expect([...ctx.recorded.eventSchemas.keys()]).toEqual(['weather.alert_raised'])
    expect(ctx.recorded.skills).toEqual([])
    expect(ctx.recorded.agents).toEqual([])
    expect(ctx.recorded.routes).toEqual([])
    expect(ctx.recorded.deliveries).toEqual([])
    expect(ctx.recorded.events).toEqual([])
  })

  test('config: units default to metric, homeCity is optional, bad units are rejected', async () => {
    const good = await setupFakePlugin(createWeatherPlugin(), { config: {} })
    expect(good.config).toEqual({ units: 'metric' })
    const error = await rejection(setupFakePlugin(createWeatherPlugin(), { config: { units: 'kelvin' } }))
    expect(isKeithError(error, 'CONFIG_INVALID')).toBe(true)
  })

  test('the event schema accepts an alert and rejects a malformed one', async () => {
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: DRY }))
    const schema = ctx.recorded.eventSchemas.get('weather.alert_raised')
    const alert = {
      city: 'Surabaya',
      condition: 'rain',
      at: '2026-09-27T16:00',
      timezone: 'Asia/Jakarta',
      precipitationProbability: 80,
    }
    expect(schema?.safeParse(alert).success).toBe(true)
    expect(schema?.safeParse({ ...alert, condition: 'snow' }).success).toBe(false)
  })
})

describe('weather service', () => {
  test('geocodes, then asks for the forecast with the configured units', async () => {
    const r = replay({ geocoding: SURABAYA, forecast: DRY_IMPERIAL })
    const { ctx } = await load(r, { units: 'imperial' })
    const f: Forecast = await ctx.services.get('weather').forecast('  Surabaya ')
    const [geo, forecast] = r.urls
    expect(geo?.origin + (geo?.pathname ?? '')).toBe('https://geocoding-api.open-meteo.com/v1/search')
    expect(geo?.searchParams.get('name')).toBe('Surabaya')
    expect(geo?.searchParams.get('count')).toBe('1')
    expect(forecast?.origin + (forecast?.pathname ?? '')).toBe('https://api.open-meteo.com/v1/forecast')
    expect(forecast?.searchParams.get('latitude')).toBe('-7.24917')
    expect(forecast?.searchParams.get('longitude')).toBe('112.75083')
    expect(forecast?.searchParams.get('temperature_unit')).toBe('fahrenheit')
    expect(forecast?.searchParams.get('wind_speed_unit')).toBe('mph')
    expect(forecast?.searchParams.get('precipitation_unit')).toBe('inch')
    expect(forecast?.searchParams.get('timezone')).toBe('auto')
    expect(f).toMatchObject({
      city: 'Surabaya',
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      units: 'imperial',
      unitLabels: { temperature: '°F', windSpeed: 'mph', precipitation: 'in' },
      current: { time: '2026-09-26T23:15', temperature: 81.7, humidity: 71, summary: 'clear sky' },
    })
    expect(f.hourly).toHaveLength(12)
    expect(f.hourly.some((h) => h.rainLikely)).toBe(false)
  })

  test('an unknown place is NOT_FOUND, an upstream error is PROVIDER_ERROR', async () => {
    const missing = await load(replay({ geocoding: NO_PLACE, forecast: DRY }))
    const e1 = await rejection(missing.ctx.services.get('weather').forecast('Nowhereville Qx'))
    expect(isKeithError(e1, 'NOT_FOUND')).toBe(true)

    const failing = await load(replay({ geocoding: SURABAYA, forecast: BAD_REQUEST }))
    const e2 = await rejection(failing.ctx.services.get('weather').forecast('Surabaya'))
    expect(isKeithError(e2, 'PROVIDER_ERROR')).toBe(true)
    expect(String((e2 as Error).message)).toContain('HTTP 400: Latitude must be in range')

    const garbage = await load(replay({ geocoding: SURABAYA, forecast: { body: { nope: true } } }))
    const e3 = await rejection(garbage.ctx.services.get('weather').forecast('Surabaya'))
    expect(isKeithError(e3, 'PROVIDER_ERROR')).toBe(true)
  })

  test('an aborted signal aborts the request', async () => {
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: DRY }))
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(
      ctx.services.get('weather').forecast('Surabaya', { signal: controller.signal }),
    )
    expect((error as Error).name).toBe('AbortError')
  })
})

describe('weather.current', () => {
  test('returns content and a valid card with keyValue details and a Refresh action', async () => {
    const { ctx, tool } = await load(replay({ geocoding: SURABAYA, forecast: DRY }))
    const result = await tool.run({ city: 'Surabaya' }, runCtx(ctx))
    expect(result.error).toBeUndefined()
    expect(result.content).toBe(
      'Surabaya, Indonesia at 23:15 local time: 27.6°C (feels like 30.3°C), clear sky, humidity 71%, ' +
        'wind 14.7 km/h. No rain expected in the next 6 hours.',
    )
    const ui = UiBlock.parse(result.ui)
    expect(ui).toMatchObject({
      type: 'card',
      id: 'weather',
      title: 'Surabaya',
      children: [
        { type: 'keyValue', id: 'weather_details' },
        {
          type: 'actions',
          id: 'weather_actions',
          actions: [{ id: 'refresh', label: 'Refresh', value: { city: 'Surabaya' } }],
        },
      ],
    })
  })

  test('uiBlockToText gives a readable fallback', async () => {
    const { ctx, tool } = await load(replay({ geocoding: SURABAYA, forecast: RAIN }))
    const result = await tool.run({ city: 'Surabaya' }, runCtx(ctx))
    const ui = UiBlock.parse(result.ui)
    expect(uiBlockToText(ui)).toBe(
      [
        'Surabaya (Indonesia, 11:15 local time)',
        '**31.2°C**, overcast. Rain expected around 16:00 (80% chance).',
        'Feels like: 36.4°C',
        'Humidity: 78%',
        'Wind: 12 km/h',
        'Precipitation: 0 mm',
        '[Refresh]',
        'Weather data by Open-Meteo.com',
      ].join('\n'),
    )
  })

  test('input is a non-empty city; minTier is member', async () => {
    const { tool } = await load(replay({ geocoding: SURABAYA, forecast: DRY }))
    expect(tool.input.safeParse({ city: 'Berlin' }).success).toBe(true)
    expect(tool.input.safeParse({ city: '' }).success).toBe(false)
    expect(tool.input.safeParse({}).success).toBe(false)
    expect(tool.minTier).toBe('member')
  })
})

describe('onAction', () => {
  test('refresh fetches again and returns an updated card', async () => {
    const r = replay({ geocoding: SURABAYA, forecast: [DRY, RAIN] })
    const { ctx, tool } = await load(r)
    const first = await tool.run({ city: 'Surabaya' }, runCtx(ctx))
    const refreshed = await onAction(tool, refresh('Surabaya'), runCtx(ctx))
    expect(r.urls).toHaveLength(4)
    expect(refreshed?.content).toContain('Rain expected around 16:00')
    const ui = UiBlock.parse(refreshed?.ui)
    expect(ui).toMatchObject({ type: 'card', id: 'weather', subtitle: 'Indonesia, 11:15 local time' })
    expect(ui).not.toEqual(UiBlock.parse(first.ui))
  })

  test('other actions add nothing; a refresh without a city is rejected', async () => {
    const r = replay({ geocoding: SURABAYA, forecast: DRY })
    const { ctx, tool } = await load(r)
    expect(await onAction(tool, refresh('Surabaya', { actionId: 'other' }), runCtx(ctx))).toBeUndefined()
    expect(await onAction(tool, refresh('Surabaya', { blockId: 'other' }), runCtx(ctx))).toBeUndefined()
    const error = await rejection(onAction(tool, refresh(''), runCtx(ctx)))
    expect(isKeithError(error, 'TOOL_INPUT_INVALID')).toBe(true)
    expect(r.urls).toHaveLength(0)
  })
})

describe('arrival', () => {
  const arrive = (ctx: FakePluginContext<unknown>) =>
    ctx.fire('person.arrived', { personId: tony, awayMs: 8 * 3_600_000 })

  test('rain in the next hours at homeCity: one delivery and one alert', async () => {
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: RAIN }), { homeCity: 'Surabaya' })
    await arrive(ctx)
    expect(ctx.recorded.deliveries).toEqual([
      { personId: tony, text: 'Rain expected in Surabaya around 16:00 (80% chance).', urgency: 'normal' },
    ])
    expect(ctx.recorded.events).toEqual([
      {
        name: 'weather.alert_raised',
        data: {
          city: 'Surabaya',
          condition: 'rain',
          at: '2026-09-27T16:00',
          timezone: 'Asia/Jakarta',
          precipitationProbability: 80,
        },
      },
    ])
  })

  test('no rain: no delivery, no alert', async () => {
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: DRY }), { homeCity: 'Surabaya' })
    await arrive(ctx)
    expect(ctx.recorded.deliveries).toEqual([])
    expect(ctx.recorded.events).toEqual([])
  })

  test('rain only beyond the look-ahead window: no delivery', async () => {
    const late = (await Bun.file(
      new URL('./fixtures/synthetic-forecast-surabaya-rain.json', import.meta.url),
    ).json()) as {
      hourly: { precipitation_probability: number[]; weather_code: number[] }
    }
    // Synthetic: move the rain from 16:00 to 20:00 (index 9, outside the first 6 hours).
    late.hourly.precipitation_probability = late.hourly.precipitation_probability.map((_, i) =>
      i === 9 ? 90 : 0,
    )
    late.hourly.weather_code = late.hourly.weather_code.map((_, i) => (i === 9 ? 63 : 3))
    const { ctx } = await load(replay({ geocoding: SURABAYA, forecast: { body: late } }), {
      homeCity: 'Surabaya',
    })
    await arrive(ctx)
    expect(ctx.recorded.deliveries).toEqual([])
  })

  test('without homeCity nothing is fetched', async () => {
    const r = replay({ geocoding: SURABAYA, forecast: RAIN })
    const { ctx } = await load(r)
    await arrive(ctx)
    expect(r.urls).toHaveLength(0)
    expect(ctx.recorded.deliveries).toEqual([])
  })

  test('a failing forecast is logged, not thrown, and delivers nothing', async () => {
    const { ctx } = await load(replay({ geocoding: NO_PLACE, forecast: RAIN }), { homeCity: 'Atlantis' })
    await arrive(ctx)
    expect(ctx.recorded.deliveries).toEqual([])
    expect(ctx.log.entries.some((l) => l.level === 'warn' && l.msg === 'arrival forecast failed')).toBe(true)
  })
})
