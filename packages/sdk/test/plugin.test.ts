import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  type AnyPluginDefinition,
  definePlugin,
  isKeithError,
  KIND_REGISTRIES,
  PLUGIN_KINDS,
} from '../src/index.ts'
import { createFakePluginContext, setupFakePlugin } from '../src/testing/index.ts'
import sample from './fixtures/sample-plugin.ts'

const tony = 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z'

describe('sample plugin against the fake context', () => {
  test('registers its tool, skill, agent and service', async () => {
    const ctx = await setupFakePlugin(sample, { config: { apiKey: 'k' } })
    expect(ctx.recorded.tools.map((t) => t.name)).toEqual(['sample.current_weather'])
    expect(ctx.recorded.skills.map((s) => s.name)).toEqual(['sample_briefing'])
    expect(ctx.recorded.agents.map((a) => a.id)).toEqual(['sample_forecaster'])
    expect(ctx.recorded.services.has('sample_weather')).toBe(true)
    expect(ctx.recorded.eventSchemas.has('sample.alert_raised')).toBe(true)
  })

  test('config is parsed with the plugin schema, defaults applied', async () => {
    const ctx = await setupFakePlugin(sample, { config: { apiKey: 'k' } })
    expect(ctx.config).toEqual({ apiKey: 'k', units: 'metric' })
    expect(ctx.log.entries[0]).toMatchObject({ msg: 'sample setup', fields: { units: 'metric' } })
  })

  test('invalid config fails with CONFIG_INVALID', async () => {
    const error = await setupFakePlugin(sample, { config: {} }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isKeithError(error, 'CONFIG_INVALID')).toBe(true)
  })

  test('its tool uses the service it provides', async () => {
    const ctx = await setupFakePlugin(sample, { config: { apiKey: 'k' }, start: true })
    const tool = ctx.recorded.tools[0]
    const person = { id: tony, name: 'Tony', tier: 'owner' } as const
    const result = await tool?.run(
      { city: 'Surabaya' },
      {
        person,
        participants: [person],
        threadId: null,
        taskId: null,
        signal: new AbortController().signal,
        log: ctx.log,
        services: ctx.services,
      },
    )
    expect(result?.content).toBe('31°C in Surabaya')
    expect(result?.ui).toMatchObject({ type: 'card', title: 'Surabaya' })
    expect(await ctx.data.get<number>('startedAt')).toBe(0)
  })

  test('reacts to a core event with a delivery and its own event', async () => {
    const ctx = await setupFakePlugin(sample, { config: { apiKey: 'k' } })
    await ctx.fire('person.arrived', { personId: tony, awayMs: 5_000_000 })
    expect(ctx.recorded.deliveries).toEqual([{ personId: tony, text: 'Rain at 16:00.', urgency: 'normal' }])
    expect(ctx.recorded.events).toEqual([
      { name: 'sample.alert_raised', data: { city: 'Surabaya', level: 'warn' } },
    ])
  })
})

describe('definePlugin', () => {
  test('is an identity function', () => {
    const def = { id: 'x', namespace: 'x', version: '1', kind: 'tool' as const, setup() {} }
    expect(definePlugin(def)).toBe(def)
  })

  test('infers ctx.config from the schema (type test)', () => {
    definePlugin({
      id: 'x',
      namespace: 'x',
      version: '1',
      kind: 'tool',
      config: z.object({ n: z.number().default(1) }),
      setup(ctx) {
        const n: number = ctx.config.n
        // @ts-expect-error: `missing` is not in the schema
        ctx.config.missing
        // @ts-expect-error: n is a number, not a string
        const s: string = ctx.config.n
        void [n, s]
      },
    })
  })

  test('a plugin without config gets an empty config', async () => {
    const plugin = definePlugin({ id: 'x', namespace: 'x', version: '1', kind: 'tool', setup() {} })
    expect((await setupFakePlugin(plugin)).config).toEqual({})
  })

  test('any plugin is assignable to AnyPluginDefinition (type test)', () => {
    const list: AnyPluginDefinition[] = [sample]
    expect(list).toHaveLength(1)
  })
})

describe('kind enforcement in the fake context', () => {
  const use = {
    tools: (ctx: ReturnType<typeof createFakePluginContext>) =>
      ctx.tools.register({
        name: 'x.y',
        description: '',
        input: z.object({}),
        minTier: 'owner',
        run: async () => ({ content: '' }),
      }),
    skills: (ctx: ReturnType<typeof createFakePluginContext>) =>
      ctx.skills.register({ name: 's', description: '', instructions: '' }),
    agents: (ctx: ReturnType<typeof createFakePluginContext>) =>
      ctx.agents.register({ id: 'a', description: '', system: '', tools: [], modelRole: 'background' }),
    providers: (ctx: ReturnType<typeof createFakePluginContext>) =>
      ctx.providers.llm.register({ id: 'p', stream: async function* () {} }),
    http: (ctx: ReturnType<typeof createFakePluginContext>) =>
      ctx.http.route('GET', '/a', () => new Response('')),
    ws: (ctx: ReturnType<typeof createFakePluginContext>) => ctx.ws.handle('x.a', z.object({}), () => {}),
    deliveries: (ctx: ReturnType<typeof createFakePluginContext>) =>
      void ctx.deliveries.enqueue({ personId: tony, text: 'x' }),
  } as const

  for (const kind of PLUGIN_KINDS) {
    for (const [registry, call] of Object.entries(use)) {
      const allowed = (KIND_REGISTRIES[kind] as readonly string[]).includes(registry)
      test(`${kind} ${allowed ? 'may' : 'may not'} use ctx.${registry}`, () => {
        const ctx = createFakePluginContext({ kind, config: {}, plugin: { namespace: 'x' } })
        let error: unknown = null
        try {
          call(ctx)
        } catch (e) {
          error = e
        }
        if (allowed) expect(error).toBeNull()
        else expect(isKeithError(error, 'PLUGIN_KIND_VIOLATION')).toBe(true)
      })
    }
  }
})
