import { describe, expect, test } from 'bun:test'
import {
  defineAgent,
  defineSkill,
  defineTool,
  GENERAL_AGENT_ID,
  isKeithError,
  type ServiceRegistry,
} from '@keith/sdk'
import { createFakeClock, createFakeLlm, createMemoryLogger } from '@keith/sdk/testing'
import { z } from 'zod'
import { createEventBus } from '../events/index.ts'
import { createAgentRegistry, GENERAL_AGENT_BUILTIN_TOOLS } from './agents.ts'
import { createPluginDataStores } from './data.ts'
import { createProviderRegistries, parseModelRef } from './providers.ts'
import { createServiceRegistry } from './services.ts'
import { createSkillRegistry } from './skills.ts'
import { createMemoryPluginDataRepository } from './test-fakes.ts'
import { createToolRegistry } from './tools.ts'
import type { PluginOwner } from './types.ts'

const owner = (ns: string): PluginOwner => ({ pluginId: `@test/${ns}`, namespace: ns, kind: 'tool' })
type Loose = { provide(n: string, i: unknown): void; get(n: string): unknown; find(n: string): unknown }
const loose = (s: ServiceRegistry) => s as unknown as Loose

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return isKeithError(e) ? e.code : 'other'
  }
}

describe('services', () => {
  test('provide twice is SERVICE_CONFLICT; get of a missing service is SERVICE_MISSING', () => {
    const reg = createServiceRegistry({ winners: {}, log: createMemoryLogger() })
    loose(reg.forPlugin(owner('a'))).provide('weather', { a: 1 })
    expect(codeOf(() => loose(reg.forPlugin(owner('b'))).provide('weather', { b: 1 }))).toBe(
      'SERVICE_CONFLICT',
    )
    expect(loose(reg as unknown as ServiceRegistry).get('weather')).toEqual({ a: 1 })
    expect(codeOf(() => loose(reg as unknown as ServiceRegistry).get('news'))).toBe('SERVICE_MISSING')
    expect(loose(reg as unknown as ServiceRegistry).find('news')).toBeUndefined()
  })

  test('[services] picks the winner regardless of load order', () => {
    const log = createMemoryLogger()
    const reg = createServiceRegistry({ winners: { weather: '@test/b' }, log })
    loose(reg.forPlugin(owner('b'))).provide('weather', 'b')
    loose(reg.forPlugin(owner('a'))).provide('weather', 'a')
    expect(loose(reg as unknown as ServiceRegistry).get('weather')).toBe('b')
    expect(log.entries.some((e) => e.msg === 'service provider ignored')).toBe(true)
  })

  test('removeByPlugin removes that plugin services', () => {
    const reg = createServiceRegistry({ winners: {}, log: createMemoryLogger() })
    loose(reg.forPlugin(owner('a'))).provide('weather', 1)
    reg.removeByPlugin('@test/a')
    expect(loose(reg as unknown as ServiceRegistry).find('weather')).toBeUndefined()
  })
})

describe('skills', () => {
  test('registers snake_case skills, unique, and rolls back', () => {
    const reg = createSkillRegistry()
    const view = reg.forPlugin(owner('a'))
    view.register(defineSkill({ name: 'morning_briefing', description: 'd', instructions: 'i' }))
    expect(
      codeOf(() =>
        view.register(defineSkill({ name: 'morning_briefing', description: 'd', instructions: 'i' })),
      ),
    ).toBe('TOOL_NAME_TAKEN')
    expect(
      codeOf(() => view.register(defineSkill({ name: 'Bad-Name', description: 'd', instructions: 'i' }))),
    ).toBe('TOOL_NAME_INVALID')
    expect(reg.get('morning_briefing')?.pluginId).toBe('@test/a')
    reg.removeByPlugin('@test/a')
    expect(reg.list()).toEqual([])
  })
})

describe('agents', () => {
  test('the built-in general agent has every non-reserved tool plus memory and skill built-ins', () => {
    const log = createMemoryLogger()
    const clock = createFakeClock()
    const tools = createToolRegistry({
      log,
      clock,
      services: createServiceRegistry({ winners: {}, log }),
      events: createEventBus({ log, clock }),
    })
    const tool = (name: string) =>
      defineTool({
        name,
        description: 'd',
        input: z.object({}),
        minTier: 'owner',
        run: async () => ({ content: '' }),
      })
    tools.forPlugin(owner('weather')).register(tool('weather.current'))
    tools.registerBuiltin(tool('task.start'))
    const agents = createAgentRegistry({ tools })
    const general = agents.get(GENERAL_AGENT_ID)
    expect(general?.modelRole).toBe('background')
    expect(general?.tools).toEqual(['weather.current', ...GENERAL_AGENT_BUILTIN_TOOLS])
    expect(agents.list().map((a) => a.id)).toEqual(['general'])
  })

  test('plugin agents are unique, may not shadow general, and roll back', () => {
    const agents = createAgentRegistry({ tools: { list: () => [] } })
    const view = agents.forPlugin(owner('research'))
    const agent = defineAgent({
      id: 'researcher',
      description: 'd',
      system: 's',
      tools: [],
      modelRole: 'background',
    })
    view.register(agent)
    expect(codeOf(() => view.register(agent))).toBe('TOOL_NAME_TAKEN')
    expect(codeOf(() => view.register({ ...agent, id: 'general' }))).toBe('TOOL_NAME_TAKEN')
    expect(codeOf(() => view.register({ ...agent, id: 'Bad Id' }))).toBe('TOOL_NAME_INVALID')
    expect(agents.get('researcher')).toBe(agent)
    agents.removeByPlugin('@test/research')
    expect(agents.get('researcher')).toBeUndefined()
  })
})

describe('providers', () => {
  const models = {
    foreground: 'openrouter:anthropic/claude:beta',
    background: 'fake:bg',
    utility: 'fake:util',
  } as const

  test('parseModelRef splits at the first colon', () => {
    expect(parseModelRef('openrouter:vendor/model:free')).toEqual({
      providerId: 'openrouter',
      model: 'vendor/model:free',
    })
    expect(codeOf(() => parseModelRef('nocolon'))).toBe('CONFIG_INVALID')
  })

  test('resolve maps roles to providers; unknown providers are CONFIG_INVALID', () => {
    const reg = createProviderRegistries({ models })
    const view = reg.forPlugin({ ...owner('p'), kind: 'provider' })
    const fake = createFakeLlm([])
    view.llm.register(fake)
    expect(reg.llm.resolve('background')).toEqual({ provider: fake, model: 'bg', ref: 'fake:bg' })
    expect(codeOf(() => reg.llm.resolve('foreground'))).toBe('CONFIG_INVALID')
    const or = createFakeLlm([], { id: 'openrouter' })
    view.llm.register(or)
    expect(reg.llm.resolve('foreground').model).toBe('anthropic/claude:beta')
    expect(codeOf(() => view.llm.register(createFakeLlm([])))).toBe('SERVICE_CONFLICT')
    expect(reg.llm.list().map((p) => p.id)).toEqual(['fake', 'openrouter'])
    reg.removeByPlugin('@test/p')
    expect(reg.llm.get('fake')).toBeUndefined()
    expect(reg.stt.list()).toEqual([])
  })
})

describe('plugin data', () => {
  test('stores JSON per plugin id', async () => {
    const repo = createMemoryPluginDataRepository()
    const stores = createPluginDataStores({ repo, clock: createFakeClock(5) })
    const a = stores.forPlugin(owner('a'))
    const b = stores.forPlugin(owner('b'))
    await a.set('cache:1', { at: new Date(0) })
    await a.set('cache:2', [1, 2])
    await a.set('other', 'x')
    await b.set('cache:1', 'b')
    expect(await a.get<object>('cache:1')).toEqual({ at: '1970-01-01T00:00:00.000Z' })
    expect(await a.list('cache:')).toEqual(['cache:1', 'cache:2'])
    expect(await b.get<string>('cache:1')).toBe('b')
    await a.delete('cache:1')
    expect(await a.get('cache:1')).toBeUndefined()
    const err = await a
      .set('fn', () => 1)
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isKeithError(err, 'INTERNAL')).toBe(true)
  })
})
