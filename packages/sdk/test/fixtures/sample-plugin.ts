/**
 * A sample plugin that touches every registry of `PluginContext`. It exists to be type-checked
 * (`bun run typecheck`) and is loaded by `plugin.test.ts`. A real plugin uses only the registries
 * its kind allows; `useInfraRegistries` shows the infra/client-app ones.
 */
import { z } from 'zod'
import {
  defineAgent,
  definePlugin,
  defineSkill,
  defineTool,
  type LlmProvider,
  type PluginContext,
  ProviderError,
} from '../../src/index.ts'

export type Forecast = { city: string; tempC: number }

// Services and events are typed by declaration merging (plugin-system.md).
declare module '../../src/index.ts' {
  interface ServiceMap {
    sample_weather: { forecast(city: string): Promise<Forecast> }
  }
  interface EventMap {
    'sample.alert_raised': { city: string; level: 'warn' | 'severe' }
  }
}

export const currentWeather = defineTool({
  name: 'sample.current_weather',
  description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
  minTier: 'member',
  timeoutMs: 5_000,
  async run(input, t) {
    const weather = t.services.get('sample_weather')
    const w = await weather.forecast(input.city)
    return {
      content: `${w.tempC}°C in ${w.city}`,
      ui: { type: 'card', id: 'w1', title: input.city, body: `${w.tempC}°C` },
    }
  },
  async onAction(action) {
    return { content: `clicked ${action.actionId}` }
  },
})

export const briefing = defineSkill({
  name: 'sample_briefing',
  description: 'How to brief about the weather.',
  instructions: async () => 'Lead with rain.',
})

export const forecaster = defineAgent({
  id: 'sample_forecaster',
  description: 'Looks up weather in the background.',
  system: 'You look up the weather.',
  tools: ['sample.current_weather'],
  modelRole: 'background',
})

const config = z.object({
  apiKey: z.string(),
  units: z.enum(['metric', 'imperial']).default('metric'),
})

export default definePlugin({
  id: '@keith/tool-sample',
  namespace: 'sample',
  version: '0.1.0',
  kind: 'tool',
  config,
  needs: [],
  setup(ctx) {
    // ctx.config is inferred from the schema: units has its default applied.
    const units: 'metric' | 'imperial' = ctx.config.units
    ctx.log.info('sample setup', { units })
    ctx.services.provide('sample_weather', {
      forecast: async (city) => ({ city, tempC: units === 'metric' ? 31 : 88 }),
    })
    ctx.events.define(
      'sample.alert_raised',
      z.object({ city: z.string(), level: z.enum(['warn', 'severe']) }),
    )
    ctx.events.on('person.arrived', async (e) => {
      if (e.data.awayMs === null) return
      await ctx.deliveries.enqueue({ personId: e.data.personId, text: 'Rain at 16:00.', urgency: 'normal' })
      ctx.events.emit('sample.alert_raised', { city: 'Surabaya', level: 'warn' })
    })
    ctx.tools.register(currentWeather)
    ctx.skills.register(briefing)
    ctx.agents.register(forecaster)
  },
  async start(ctx) {
    await ctx.data.set('startedAt', ctx.clock.now())
  },
  async stop(ctx) {
    await ctx.data.delete('startedAt')
  },
})

/** The registries of other kinds, for the type check. Never called at runtime by the tests. */
export function useInfraRegistries(ctx: PluginContext<{ apiKey: string }>): void {
  const llm: LlmProvider = {
    id: 'sample',
    async *stream() {
      yield { type: 'finish', reason: 'stop' }
      throw new ProviderError('unknown')
    },
  }
  ctx.providers.llm.register(llm)
  ctx.http.route('GET', '/icon.svg', () => new Response('<svg/>'), { auth: 'none' })
  ctx.http.static('/', `${ctx.paths.data}/public`, { spaFallback: 'index.html' })
  ctx.ws.handle('sample.linked', z.object({ chatId: z.string() }), (data, c) => {
    ctx.log.info('linked', { data, nodeId: c.nodeId })
  })
}
