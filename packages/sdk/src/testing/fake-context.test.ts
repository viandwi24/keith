import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { isKeithError } from '../errors.ts'
import { createFakeClock, createFakePluginContext, createMemoryLogger } from './fake-context.ts'

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return null
}

const tool = (name: string) => ({
  name,
  description: '',
  input: z.object({}),
  minTier: 'owner' as const,
  run: async () => ({ content: '' }),
})

describe('createFakePluginContext', () => {
  test('services: provide, get, find, conflict, missing', () => {
    const ctx = createFakePluginContext({ kind: 'tool', config: {}, services: { other: 1 } })
    expect(ctx.services.find('nope' as never)).toBeUndefined()
    expect(
      isKeithError(
        thrown(() => ctx.services.get('nope' as never)),
        'SERVICE_MISSING',
      ),
    ).toBe(true)
    expect(ctx.services.get('other' as never)).toBe(1 as never)
    ctx.services.provide('mine' as never, 2 as never)
    expect(
      isKeithError(
        thrown(() => ctx.services.provide('mine' as never, 3 as never)),
        'SERVICE_CONFLICT',
      ),
    ).toBe(true)
  })

  test('tools must start with the plugin namespace and be unique', () => {
    const ctx = createFakePluginContext({ kind: 'tool', config: {}, plugin: { namespace: 'weather' } })
    ctx.tools.register(tool('weather.current'))
    expect(
      isKeithError(
        thrown(() => ctx.tools.register(tool('news.latest'))),
        'TOOL_NAME_INVALID',
      ),
    ).toBe(true)
    expect(
      isKeithError(
        thrown(() => ctx.tools.register(tool('weather.current'))),
        'TOOL_NAME_TAKEN',
      ),
    ).toBe(true)
  })

  test('emit is limited to the plugin namespace', () => {
    const ctx = createFakePluginContext({ kind: 'tool', config: {}, plugin: { namespace: 'weather' } })
    const error = thrown(() =>
      ctx.events.emit('task.completed', {
        taskId: 'tsk_x' as never,
        personId: 'per_x' as never,
        summary: '',
      }),
    )
    expect(isKeithError(error, 'PLUGIN_NAMESPACE_INVALID')).toBe(true)
  })

  test('event handlers run after emit returns, and a throwing handler is isolated', async () => {
    const ctx = createFakePluginContext({ kind: 'tool', config: {} })
    const seen: string[] = []
    ctx.events.on('scheduler.ticked', () => {
      throw new Error('boom')
    })
    ctx.events.on('scheduler.ticked', (e) => {
      seen.push(`tick ${e.data.at} at ${e.at}`)
    })
    const fired = ctx.fire('scheduler.ticked', { at: 5 })
    expect(seen).toEqual([])
    await fired
    expect(seen).toEqual(['tick 5 at 0'])
    expect(ctx.log.entries.some((l) => l.level === 'error' && l.msg === 'event handler failed')).toBe(true)
  })

  test('unsubscribe stops delivery', async () => {
    const ctx = createFakePluginContext({ kind: 'tool', config: {} })
    let count = 0
    const off = ctx.events.on('scheduler.ticked', () => {
      count++
    })
    await ctx.fire('scheduler.ticked', { at: 1 })
    off()
    await ctx.fire('scheduler.ticked', { at: 2 })
    expect(count).toBe(1)
  })

  test('data store round-trips JSON and lists by prefix', async () => {
    const ctx = createFakePluginContext({ kind: 'infra', config: {} })
    await ctx.data.set('cache:a', { n: 1 })
    await ctx.data.set('cache:b', [1, 2])
    await ctx.data.set('other', 'x')
    expect(await ctx.data.get<{ n: number }>('cache:a')).toEqual({ n: 1 })
    expect(await ctx.data.list('cache:')).toEqual(['cache:a', 'cache:b'])
    await ctx.data.delete('cache:a')
    expect(await ctx.data.get('cache:a')).toBeUndefined()
  })

  test('deliveries get valid, increasing ids', async () => {
    const ctx = createFakePluginContext({ kind: 'client-app', config: {} })
    const a = await ctx.deliveries.enqueue({ personId: 'per_x', text: 'one' })
    const b = await ctx.deliveries.enqueue({ personId: 'per_x', text: 'two' })
    expect(a.deliveryId).toMatch(/^dlv_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a.deliveryId < b.deliveryId).toBe(true)
  })

  test('ws frame types must start with the plugin namespace', () => {
    const ctx = createFakePluginContext({ kind: 'client-app', config: {}, plugin: { namespace: 'telegram' } })
    ctx.ws.handle('telegram.linked', z.object({}), () => {})
    expect(
      isKeithError(
        thrown(() => ctx.ws.handle('other.x', z.object({}), () => {})),
        'PLUGIN_NAMESPACE_INVALID',
      ),
    ).toBe(true)
  })

  test('plugin info defaults', () => {
    const ctx = createFakePluginContext({ kind: 'provider', config: { a: 1 } })
    expect(ctx.plugin).toEqual({ id: '@keith/fake', namespace: 'fake', version: '0.0.0', kind: 'provider' })
    expect(ctx.config).toEqual({ a: 1 })
  })
})

describe('createFakeClock', () => {
  test('moves only when told to', () => {
    const clock = createFakeClock(1_000)
    expect(clock.now()).toBe(1_000)
    clock.advance(500)
    expect(clock.now()).toBe(1_500)
    clock.set(10)
    expect(clock.now()).toBe(10)
  })
})

describe('createMemoryLogger', () => {
  test('child loggers add fields and share entries', () => {
    const log = createMemoryLogger({ a: 1 })
    log.child({ b: 2 }).warn('slow tool', { ms: 9 })
    expect(log.entries).toEqual([{ level: 'warn', msg: 'slow tool', fields: { a: 1, b: 2, ms: 9 } }])
  })
})
