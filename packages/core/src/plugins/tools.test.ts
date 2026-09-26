import { afterEach, describe, expect, jest, test } from 'bun:test'
import type { PersonDto, Tier } from '@keith/protocol'
import { defineTool, isKeithError, type Tool } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { z } from 'zod'
import { createEventBus } from '../events/index.ts'
import { createServiceRegistry } from './services.ts'
import { createToolRegistry } from './tools.ts'
import type { ToolInvocation } from './types.ts'

afterEach(() => {
  jest.useRealTimers()
})

function person(tier: Tier, n = 1): PersonDto {
  return { id: `per_01J8ZQ3K4M5N6P7Q8R9S0T1V3${n}`, name: `P${n}`, tier }
}

function setup() {
  const log = createMemoryLogger()
  const clock = createFakeClock(0)
  const events = createEventBus({ log, clock })
  const services = createServiceRegistry({ winners: {}, log })
  const tools = createToolRegistry({ log, clock, services, events })
  const weather = tools.forPlugin({ pluginId: '@keith/tool-weather', namespace: 'weather', kind: 'tool' })
  return { log, clock, events, tools, weather }
}

function call(participants: PersonDto[], signal = new AbortController().signal): ToolInvocation {
  const [first] = participants
  if (!first) throw new Error('need a participant')
  return { toolCallId: 'call_1', person: first, participants, threadId: null, taskId: null, signal }
}

function counting(overrides: Partial<Tool> = {}) {
  const calls: unknown[] = []
  const input = z.object({ city: z.string() })
  const tool: Tool = {
    ...defineTool({
      name: 'weather.current',
      description: 'Current weather.',
      input,
      minTier: 'member',
      run: async (args) => {
        calls.push(args)
        return { content: `sunny in ${args.city}` }
      },
    }),
    ...overrides,
  }
  return { tool, calls }
}

describe('tool registration', () => {
  test('plugin tools must start with the plugin namespace and be unique', () => {
    const { tools, weather } = setup()
    weather.register(counting().tool)
    const codeOf = (fn: () => void) => {
      try {
        fn()
        return 'ok'
      } catch (e) {
        return isKeithError(e) ? e.code : 'other'
      }
    }
    expect(codeOf(() => weather.register(counting().tool))).toBe('TOOL_NAME_TAKEN')
    expect(codeOf(() => weather.register(counting({ name: 'news.latest' }).tool))).toBe('TOOL_NAME_INVALID')
    expect(codeOf(() => weather.register(counting({ name: 'weather' }).tool))).toBe('TOOL_NAME_INVALID')
    expect(codeOf(() => weather.register(counting({ name: 'weather.Bad' }).tool))).toBe('TOOL_NAME_INVALID')
    expect(codeOf(() => tools.registerBuiltin(counting({ name: 'weather.builtin' }).tool))).toBe(
      'TOOL_NAME_INVALID',
    )
    expect(codeOf(() => tools.registerBuiltin(counting({ name: 'task.start' }).tool))).toBe('ok')
    expect(tools.get('task.start')?.pluginId).toBeNull()
    expect(tools.get('weather.current')?.pluginId).toBe('@keith/tool-weather')
  })

  test('removeByPlugin drops only that plugin tools', () => {
    const { tools, weather } = setup()
    weather.register(counting().tool)
    tools.registerBuiltin(counting({ name: 'skill.load' }).tool)
    tools.removeByPlugin('@keith/tool-weather')
    expect(tools.list().map((t) => t.tool.name)).toEqual(['skill.load'])
  })

  test('list filters by tier, capabilities, names and built-ins', () => {
    const { tools, weather } = setup()
    weather.register(counting({ name: 'weather.guest', minTier: 'guest' }).tool)
    weather.register(counting({ name: 'weather.owner', minTier: 'owner' }).tool)
    weather.register(counting({ name: 'weather.fs', minTier: 'guest', requires: ['fs@1'] }).tool)
    tools.registerBuiltin(counting({ name: 'memory.recall', minTier: 'guest' }).tool)
    const names = (f: Parameters<typeof tools.list>[0]) => tools.list(f).map((t) => t.tool.name)
    expect(names({ tier: 'member' })).toEqual(['weather.guest', 'weather.fs', 'memory.recall'])
    expect(names({ tier: 'owner', capabilities: [] })).toEqual([
      'weather.guest',
      'weather.owner',
      'memory.recall',
    ])
    expect(names({ capabilities: ['fs@1'], excludeBuiltins: true })).toEqual([
      'weather.guest',
      'weather.owner',
      'weather.fs',
    ])
    expect(names({ names: ['memory.recall', 'nope.x', 'weather.owner'] })).toEqual([
      'memory.recall',
      'weather.owner',
    ])
  })
})

describe('tools.invoke', () => {
  test('runs the tool with parsed input and emits tool.called / tool.completed', async () => {
    const { tools, weather, events } = setup()
    const { tool, calls } = counting()
    weather.register(tool)
    const seen: string[] = []
    events.on('tool.called', (e) => void seen.push(`${e.name}:${e.data.name}`))
    events.on('tool.completed', (e) => void seen.push(`${e.name}:${e.data.ok}`))
    const result = await tools.invoke('weather.current', { city: 'Jakarta' }, call([person('member')]))
    expect(result).toEqual({ content: 'sunny in Jakarta' })
    expect(calls).toEqual([{ city: 'Jakarta' }])
    await events.idle()
    expect(seen).toEqual(['tool.called:weather.current', 'tool.completed:true'])
  })

  test('rejects bad input without calling run', async () => {
    const { tools, weather } = setup()
    const { tool, calls } = counting()
    weather.register(tool)
    const result = await tools.invoke('weather.current', { city: 3 }, call([person('owner')]))
    expect(result.error).toBe(true)
    expect(result.content).toContain('TOOL_INPUT_INVALID')
    expect(result.content).toContain('city')
    expect(calls).toEqual([])
  })

  test('enforces minTier against the lowest participant tier without calling run', async () => {
    const { tools, weather } = setup()
    const { tool, calls } = counting()
    weather.register(tool)
    const guestInGroup = await tools.invoke(
      'weather.current',
      { city: 'x' },
      call([person('owner', 1), person('guest', 2)]),
    )
    expect(guestInGroup.error).toBe(true)
    expect(guestInGroup.content).toContain('TIER_INSUFFICIENT')
    expect(calls).toEqual([])
    const members = await tools.invoke(
      'weather.current',
      { city: 'x' },
      call([person('owner', 1), person('member', 2)]),
    )
    expect(members.error).toBeUndefined()
  })

  test('times out a slow tool', async () => {
    jest.useFakeTimers()
    const { tools, weather } = setup()
    let aborted = false
    weather.register(
      defineTool({
        name: 'weather.slow',
        description: 'slow',
        input: z.object({}),
        minTier: 'guest',
        timeoutMs: 1_000,
        run: (_input, t) =>
          new Promise(() => {
            t.signal.addEventListener('abort', () => {
              aborted = true
            })
          }),
      }),
    )
    const pending = tools.invoke('weather.slow', {}, call([person('guest')]))
    await Promise.resolve()
    jest.advanceTimersByTime(1_000)
    const result = await pending
    expect(result.error).toBe(true)
    expect(result.content).toContain('TOOL_TIMEOUT')
    expect(aborted).toBe(true)
  })

  test('converts throws and unknown tools into error results', async () => {
    const { tools, weather, log } = setup()
    weather.register(
      counting({
        name: 'weather.broken',
        run: async () => {
          throw new Error('api down')
        },
      }).tool,
    )
    const thrown = await tools.invoke('weather.broken', { city: 'x' }, call([person('owner')]))
    expect(thrown).toEqual({ error: true, content: "INTERNAL: tool 'weather.broken' failed: api down" })
    expect(log.entries.some((e) => e.msg === 'tool failed')).toBe(true)
    const unknown = await tools.invoke('weather.none', {}, call([person('owner')]))
    expect(unknown.error).toBe(true)
    expect(unknown.content).toContain('weather.none')
  })

  test('a caller abort ends the call and aborts the tool', async () => {
    const { tools, weather } = setup()
    const controller = new AbortController()
    let aborted = false
    weather.register(
      counting({
        name: 'weather.hang',
        run: (_i, t) =>
          new Promise(() => {
            t.signal.addEventListener('abort', () => {
              aborted = true
            })
          }),
      }).tool,
    )
    const pending = tools.invoke('weather.hang', { city: 'x' }, call([person('owner')], controller.signal))
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(result.error).toBe(true)
    expect(aborted).toBe(true)
  })

  test('tool runs get the core services lookup and a tagged logger', async () => {
    const log = createMemoryLogger()
    const clock = createFakeClock(0)
    const services = createServiceRegistry({ winners: {}, log })
    ;(
      services.forPlugin({ pluginId: '@x/p', namespace: 'p', kind: 'tool' }) as unknown as {
        provide(n: string, v: unknown): void
      }
    ).provide('geo', { where: 'here' })
    const tools = createToolRegistry({ log, clock, services, events: createEventBus({ log, clock }) })
    tools.registerBuiltin(
      defineTool({
        name: 'task.probe',
        description: 'probe',
        input: z.object({}),
        minTier: 'guest',
        run: async (_i, t) => {
          t.log.info('probing')
          const geo = (t.services as unknown as { find(n: string): { where: string } | undefined }).find(
            'geo',
          )
          return { content: geo?.where ?? 'none' }
        },
      }),
    )
    expect((await tools.invoke('task.probe', {}, call([person('guest')]))).content).toBe('here')
    expect(log.entries).toContainEqual({
      level: 'info',
      msg: 'probing',
      fields: { tool: 'task.probe', toolCallId: 'call_1' },
    })
  })
})
