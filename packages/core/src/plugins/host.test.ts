import { afterEach, describe, expect, jest, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  type AnyPluginDefinition,
  defineAgent,
  defineSkill,
  defineTool,
  isKeithError,
  type KeithError,
  type ServiceRegistry,
} from '@keith/sdk'
import { createFakeLlm, createFakeLlmPlugin } from '@keith/sdk/testing'
import { z } from 'zod'
import { createHarness, type Harness, testPlugin } from './test-fakes.ts'

type LooseServices = {
  provide(n: string, i: unknown): void
  get(n: string): unknown
  find(n: string): unknown
}
/** Real plugins type services by declaration merging; tests use loose names. */
const svc = (s: ServiceRegistry) => s as unknown as LooseServices

const llmPlugin = () => createFakeLlmPlugin(createFakeLlm([]))

const echoTool = (name: string) =>
  defineTool({
    name,
    description: 'echo',
    input: z.object({}),
    minTier: 'guest',
    run: async () => ({ content: 'ok' }),
  })

async function rejection(p: Promise<unknown>): Promise<KeithError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  if (!isKeithError(e)) throw new Error(`expected a KeithError, got ${String(e)}`)
  return e
}

let h: Harness | undefined
afterEach(async () => {
  jest.useRealTimers()
  await h?.cleanup()
  h = undefined
})

async function harness(opts: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness(opts)
  return h
}

describe('PluginHost kinds', () => {
  test('a tool plugin calling ctx.http.route fails setup with PLUGIN_KIND_VIOLATION and the core continues', async () => {
    const { host, events, deps, http } = await harness()
    const failed: unknown[] = []
    events.on('plugin.failed', (e) => {
      failed.push(e.data)
    })
    let caught: unknown
    const bad = testPlugin('bad', 'tool', {
      setup(ctx) {
        ctx.tools.register(echoTool('bad.echo'))
        try {
          ctx.http.route('GET', '/x', () => new Response('x'))
        } catch (e) {
          caught = e
          throw e
        }
      },
    })
    const good = testPlugin('good', 'tool', { setup: (ctx) => ctx.tools.register(echoTool('good.echo')) })
    await host.load(h?.config ?? ({} as never), [llmPlugin(), bad, good])
    await host.startAll()
    expect(isKeithError(caught, 'PLUGIN_KIND_VIOLATION')).toBe(true)
    expect(http.items).toEqual([])
    const status = host.status()
    expect(status.find((s) => s.id === '@test/bad')).toMatchObject({
      state: 'failed',
      error: { stage: 'setup' },
    })
    expect(status.find((s) => s.id === '@test/good')?.state).toBe('started')
    // Rolled back: the bad plugin's tool is gone, the good one stays.
    expect(deps.tools.get('bad.echo')).toBeUndefined()
    expect(deps.tools.get('good.echo')?.pluginId).toBe('@test/good')
    await events.idle()
    expect(failed).toEqual([
      { pluginId: '@test/bad', stage: 'setup', error: expect.stringContaining('ctx.http') },
    ])
  })

  test('each kind may use only its registries (kind table)', async () => {
    const { host, config, http, ws, deliveries } = await harness()
    const results: Record<string, string[]> = {}
    const probe = (name: string, fn: () => unknown) => {
      try {
        fn()
        return `${name}:ok`
      } catch (e) {
        return `${name}:${isKeithError(e) ? e.code : 'other'}`
      }
    }
    const probes =
      (ns: string): AnyPluginDefinition['setup'] =>
      (ctx) => {
        results[ns] = [
          probe('tools', () => ctx.tools.register(echoTool(`${ns}.t`))),
          probe('skills', () =>
            ctx.skills.register(defineSkill({ name: `${ns}_s`, description: 'd', instructions: 'i' })),
          ),
          probe('agents', () =>
            ctx.agents.register(
              defineAgent({
                id: `${ns}_a`,
                description: 'd',
                system: 's',
                tools: [],
                modelRole: 'background',
              }),
            ),
          ),
          probe('providers', () =>
            ctx.providers.llm.register({ id: `${ns}llm`, stream: createFakeLlm([]).stream }),
          ),
          probe('http', () => ctx.http.route('GET', '/x', () => new Response(''))),
          probe('ws', () => ctx.ws.handle(`${ns}.frame`, z.object({}), () => {})),
          probe('deliveries', () => ctx.deliveries.enqueue({ personId: 'per_x', text: 'hi' })),
        ]
      }
    await host.load(config, [
      llmPlugin(),
      testPlugin('inf', 'infra', { setup: probes('inf') }),
      testPlugin('prov', 'provider', { setup: probes('prov') }),
      testPlugin('tl', 'tool', { setup: probes('tl') }),
      testPlugin('app', 'client-app', { setup: probes('app') }),
    ])
    const V = 'PLUGIN_KIND_VIOLATION'
    expect(results.inf).toEqual([
      `tools:${V}`,
      `skills:${V}`,
      `agents:${V}`,
      `providers:${V}`,
      'http:ok',
      'ws:ok',
      `deliveries:${V}`,
    ])
    expect(results.prov).toEqual([
      `tools:${V}`,
      `skills:${V}`,
      `agents:${V}`,
      'providers:ok',
      `http:${V}`,
      `ws:${V}`,
      `deliveries:${V}`,
    ])
    expect(results.tl).toEqual([
      'tools:ok',
      'skills:ok',
      'agents:ok',
      `providers:${V}`,
      `http:${V}`,
      `ws:${V}`,
      'deliveries:ok',
    ])
    expect(results.app).toEqual([
      `tools:${V}`,
      `skills:${V}`,
      `agents:${V}`,
      `providers:${V}`,
      'http:ok',
      'ws:ok',
      'deliveries:ok',
    ])
    expect(http.items.map((i) => i.pluginId)).toEqual(['@test/inf', '@test/app'])
    expect(ws.items.map((i) => i.value)).toEqual(['inf.frame', 'app.frame'])
    expect(deliveries.items.map((i) => i.pluginId)).toEqual(['@test/tl', '@test/app'])
  })

  test('ws frame types must be in the plugin namespace', async () => {
    const { host, config } = await harness()
    let code = ''
    await host.load(config, [
      llmPlugin(),
      testPlugin('web', 'client-app', {
        setup(ctx) {
          try {
            ctx.ws.handle('telegram.linked', z.object({}), () => {})
          } catch (e) {
            code = isKeithError(e) ? e.code : 'other'
          }
        },
      }),
    ])
    expect(code).toBe('PLUGIN_NAMESPACE_INVALID')
  })
})

describe('PluginHost services', () => {
  test('services.get in setup throws a clear error; in start it resolves another plugin service', async () => {
    const { host, config } = await harness()
    let setupError: unknown
    let fromStart: unknown
    const provider = testPlugin('weather', 'tool', {
      setup(ctx) {
        svc(ctx.services).provide('weather', { forecast: () => 'sunny' })
      },
    })
    const consumer = testPlugin('briefing', 'tool', {
      setup(ctx) {
        try {
          svc(ctx.services).get('weather')
        } catch (e) {
          setupError = e
        }
      },
      start(ctx) {
        fromStart = svc(ctx.services).get('weather')
      },
    })
    await host.load(config, [llmPlugin(), consumer, provider])
    await host.startAll()
    expect(isKeithError(setupError, 'SERVICE_MISSING')).toBe(true)
    expect((setupError as Error).message).toContain('in setup')
    expect((setupError as Error).message).toContain('start')
    expect(fromStart).toMatchObject({ forecast: expect.any(Function) })
    expect(host.status().every((s) => s.state === 'started')).toBe(true)
  })

  test('a missing needs service fails that plugin start with a message naming the service', async () => {
    const { host, config, events } = await harness()
    let started = false
    const failed: unknown[] = []
    events.on('plugin.failed', (e) => {
      failed.push(e.data)
    })
    await host.load(config, [
      llmPlugin(),
      testPlugin('briefing', 'tool', {
        needs: ['weather'],
        start() {
          started = true
        },
      }),
    ])
    await host.startAll()
    expect(started).toBe(false)
    const status = host.status().find((s) => s.id === '@test/briefing')
    expect(status?.state).toBe('failed')
    expect(status?.error?.stage).toBe('start')
    expect(status?.error?.message).toContain("'weather'")
    await events.idle()
    expect(failed).toHaveLength(1)
  })

  test('a start failure rolls back the plugin registrations', async () => {
    const { host, config, deps } = await harness()
    await host.load(config, [
      llmPlugin(),
      testPlugin('weather', 'tool', {
        setup(ctx) {
          svc(ctx.services).provide('weather', {})
          ctx.tools.register(echoTool('weather.now'))
        },
        start() {
          throw new Error('no network')
        },
      }),
    ])
    expect(deps.tools.get('weather.now')).toBeDefined()
    await host.startAll()
    expect(deps.tools.get('weather.now')).toBeUndefined()
    expect(svc(deps.services as unknown as ServiceRegistry).find('weather')).toBeUndefined()
    expect(host.status()[1]?.error).toEqual({ stage: 'start', message: 'no network' })
  })
})

describe('PluginHost loading', () => {
  test('imports config.plugins.enabled in order, then extra', async () => {
    const order: string[] = []
    const mk = (ns: string) => ({ default: { ...testPlugin(ns, 'tool'), setup: () => order.push(ns) } })
    const modules: Record<string, unknown> = { '@test/a': mk('a'), '@test/b': mk('b') }
    const { host, config } = await harness({
      config: { plugins: { enabled: ['@test/b', '@test/a'] } },
      importModule: async (id) => modules[id],
    })
    await host.load(config, [llmPlugin(), { ...testPlugin('c', 'tool'), setup: () => void order.push('c') }])
    expect(order).toEqual(['b', 'a', 'c'])
  })

  test('a package that cannot be imported is skipped unless required', async () => {
    const { host, config, log } = await harness({
      config: { plugins: { enabled: ['@keith/sdk', '@test/nope'] } },
    })
    await host.load(config, [llmPlugin()])
    expect(host.status().map((s) => s.id)).toEqual(['@keith/provider-fake'])
    expect(log.entries.filter((e) => e.fields.stage === 'load').map((e) => e.fields.pluginId)).toEqual([
      '@keith/sdk',
      '@test/nope',
    ])
  })

  test('a required plugin that fails makes load throw', async () => {
    const r = await harness({ config: { plugins: { required: ['@test/core'] } } })
    const failing = testPlugin('core_x', 'tool', {
      setup() {
        throw new Error('broken')
      },
    })
    const e = await rejection(r.host.load(r.config, [llmPlugin(), { ...failing, id: '@test/core' }]))
    expect(e.message).toContain('@test/core')
    expect(e.message).toContain('broken')
  })

  test('a required plugin that is not enabled or cannot be imported makes load throw', async () => {
    const a = await harness({ config: { plugins: { required: ['@test/missing'] } } })
    expect((await rejection(a.host.load(a.config, [llmPlugin()]))).code).toBe('CONFIG_INVALID')
    await a.cleanup()
    const b = await harness({ config: { plugins: { enabled: ['@test/gone'], required: ['@test/gone'] } } })
    expect((await rejection(b.host.load(b.config, [llmPlugin()]))).message).toContain('@test/gone')
  })

  test('a failing required plugin in start makes startAll throw', async () => {
    const r = await harness({ config: { plugins: { required: ['@test/x'] } } })
    await r.host.load(r.config, [
      llmPlugin(),
      testPlugin('x', 'tool', {
        start() {
          throw new Error('down')
        },
      }),
    ])
    expect((await rejection(r.host.startAll())).message).toContain('down')
  })

  test('plugin config is validated with its schema, with defaults applied', async () => {
    let seen: unknown
    const { host, config } = await harness({
      config: { plugins: { '@test/weather': { apiKey: 'k' }, '@test/broken': { apiKey: 1 } } },
    })
    const schema = z.object({ apiKey: z.string(), units: z.enum(['metric', 'imperial']).default('metric') })
    await host.load(config, [
      llmPlugin(),
      testPlugin('weather', 'tool', {
        config: schema,
        setup(ctx) {
          seen = ctx.config
        },
      }),
      testPlugin('broken', 'tool', { config: schema }),
      testPlugin('plain', 'tool'),
    ])
    expect(seen).toEqual({ apiKey: 'k', units: 'metric' })
    const broken = host.status().find((s) => s.id === '@test/broken')
    expect(broken?.state).toBe('failed')
    expect(broken?.error?.message).toContain('apiKey')
  })

  test('invalid, reserved or duplicate namespaces fail with PLUGIN_NAMESPACE_INVALID', async () => {
    const { host, config, log } = await harness()
    await host.load(config, [
      llmPlugin(),
      testPlugin('Bad-Name', 'tool'),
      testPlugin('memory', 'tool'),
      testPlugin('dup', 'tool'),
      { ...testPlugin('dup', 'tool'), id: '@test/dup2' },
    ])
    const failed = host.status().filter((s) => s.state === 'failed')
    expect(failed.map((s) => s.id)).toEqual(['@test/Bad-Name', '@test/memory', '@test/dup2'])
    expect(
      log.entries
        .filter((e) => e.msg === 'plugin failed')
        .every((e) => e.fields.code === 'PLUGIN_NAMESPACE_INVALID'),
    ).toBe(true)
  })

  test('ctx carries plugin info, a tagged logger, a data dir and a scoped data store', async () => {
    const { host, config, repo, log } = await harness()
    let dir = ''
    await host.load(config, [
      llmPlugin(),
      testPlugin('notes', 'tool', {
        async setup(ctx) {
          dir = ctx.paths.data
          ctx.log.info('hello')
          expect(ctx.plugin).toEqual({
            id: '@test/notes',
            namespace: 'notes',
            version: '1.0.0',
            kind: 'tool',
          })
          await ctx.data.set('a', { n: 1 })
          expect(await ctx.data.get<object>('a')).toEqual({ n: 1 })
        },
      }),
    ])
    expect(dir.endsWith('plugins/@test/notes')).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(repo.rows.size).toBe(1)
    expect(log.entries).toContainEqual({ level: 'info', msg: 'hello', fields: { pluginId: '@test/notes' } })
  })
})

describe('PluginHost providers', () => {
  test("llm.resolve('foreground') returns the provider and model id", async () => {
    const { host, config, deps } = await harness()
    await host.load(config, [llmPlugin()])
    const resolved = deps.providers.llm.resolve('foreground')
    expect(resolved.provider.id).toBe('fake')
    expect(resolved.model).toBe('fg-model')
    expect(resolved.ref).toBe('fake:fg-model')
  })

  test('an unknown provider prefix throws CONFIG_INVALID at load', async () => {
    const { host, config } = await harness({ config: { models: { utility: 'nobody:model' } } })
    const e = await rejection(host.load(config, [llmPlugin()]))
    expect(e.code).toBe('CONFIG_INVALID')
    expect(e.message).toContain('nobody')
    expect(e.message).toContain('models.utility')
  })
})

describe('PluginHost stop', () => {
  test('stops started plugins in reverse load order', async () => {
    const { host, config } = await harness()
    const order: string[] = []
    const stopper = (ns: string) => testPlugin(ns, 'tool', { stop: () => void order.push(ns) })
    await host.load(config, [llmPlugin(), stopper('a'), stopper('b'), stopper('c')])
    await host.startAll()
    await host.stopAll()
    expect(order).toEqual(['c', 'b', 'a'])
    expect(host.status().every((s) => s.state === 'stopped')).toBe(true)
  })

  test('a stop that exceeds plugins.stopTimeoutMs is abandoned and logged', async () => {
    jest.useFakeTimers()
    const { host, config, log } = await harness({ config: { plugins: { stopTimeoutMs: 100 } } })
    let second = false
    await host.load(config, [
      llmPlugin(),
      testPlugin('quick', 'tool', {
        stop() {
          second = true
        },
      }),
      testPlugin('slow', 'tool', { stop: () => new Promise<void>(() => {}) }),
    ])
    await host.startAll()
    const stopping = host.stopAll()
    await Promise.resolve()
    jest.advanceTimersByTime(100)
    await stopping
    expect(second).toBe(true)
    expect(
      log.entries.some((e) => e.msg === 'plugin stop timed out' && e.fields.pluginId === '@test/slow'),
    ).toBe(true)
  })
})
