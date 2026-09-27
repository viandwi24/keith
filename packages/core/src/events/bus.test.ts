import { describe, expect, test } from 'bun:test'
import { type EventBus, KeithError } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { z } from 'zod'
import { createEventBus } from './bus.ts'

type LooseBus = {
  emit(name: string, data: unknown): void
  on(
    name: string,
    handler: (e: { name: string; at: number; data: unknown }) => void | Promise<void>,
  ): () => void
}
/** Plugin events are declared by declaration merging in real plugins; tests use loose names. */
const loose = (bus: EventBus) => bus as unknown as LooseBus

function setup() {
  const log = createMemoryLogger()
  const clock = createFakeClock(1_000)
  const bus = createEventBus({ log, clock })
  return { log, clock, bus }
}

function thrown(fn: () => unknown): KeithError {
  try {
    fn()
  } catch (e) {
    if (e instanceof KeithError) return e
    throw e
  }
  throw new Error('expected a throw')
}

describe('createEventBus', () => {
  test('delivers { name, at, data } asynchronously after emit returns', async () => {
    const { bus } = setup()
    const seen: unknown[] = []
    bus.on('scheduler.ticked', (e) => {
      seen.push(e)
    })
    bus.emit('scheduler.ticked', { at: 5 })
    expect(seen).toEqual([])
    await bus.idle()
    expect(seen).toEqual([{ name: 'scheduler.ticked', at: 1_000, data: { at: 5 } }])
  })

  test('handler errors are isolated and logged with the plugin id', async () => {
    const { bus, log } = setup()
    const view = bus.forPlugin({ pluginId: '@keith/a', namespace: 'a', kind: 'tool' })
    const seen: string[] = []
    view.on('person.left', () => {
      throw new Error('boom')
    })
    bus.on('person.left', async () => {
      seen.push('second')
    })
    expect(() => bus.emit('person.left', { personId: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V31' })).not.toThrow()
    await bus.idle()
    expect(seen).toEqual(['second'])
    expect(log.entries).toContainEqual({
      level: 'error',
      msg: 'event handler failed',
      fields: { event: 'person.left', pluginId: '@keith/a', error: 'boom' },
    })
  })

  test('unsubscribe stops delivery', async () => {
    const { bus } = setup()
    let count = 0
    const off = bus.on('scheduler.ticked', () => {
      count++
    })
    bus.emit('scheduler.ticked', { at: 1 })
    await bus.idle()
    off()
    bus.emit('scheduler.ticked', { at: 2 })
    await bus.idle()
    expect(count).toBe(1)
  })

  test('plugins emit only in their own namespace', async () => {
    const { bus } = setup()
    const view = loose(bus.forPlugin({ pluginId: '@keith/tool-weather', namespace: 'weather', kind: 'tool' }))
    const got: unknown[] = []
    loose(bus).on('weather.alert_raised', (e) => {
      got.push(e.data)
    })
    view.emit('weather.alert_raised', { city: 'x' })
    await bus.idle()
    expect(got).toEqual([{ city: 'x' }])
    for (const name of ['task.completed', 'news.published', 'weather', 'weather.Bad']) {
      expect(thrown(() => view.emit(name, {})).code).toBe('PLUGIN_NAMESPACE_INVALID')
    }
  })

  test('the core may emit in any namespace', async () => {
    const { bus } = setup()
    expect(() => loose(bus).emit('weather.alert_raised', {})).not.toThrow()
  })

  test('payloads are validated against defined schemas at emit', async () => {
    const { bus } = setup()
    const view = bus.forPlugin({ pluginId: '@keith/tool-weather', namespace: 'weather', kind: 'tool' })
    view.define('weather.alert_raised', z.object({ city: z.string() }))
    expect(thrown(() => loose(view).emit('weather.alert_raised', { city: 1 })).code).toBe('INTERNAL')
    expect(thrown(() => view.define('news.published', z.object({}))).code).toBe('PLUGIN_NAMESPACE_INVALID')
    loose(view).emit('weather.alert_raised', { city: 'ok' })
  })

  test('removeByPlugin drops the plugin handlers and schemas', async () => {
    const { bus } = setup()
    const view = bus.forPlugin({ pluginId: '@keith/tool-weather', namespace: 'weather', kind: 'tool' })
    let count = 0
    view.on('scheduler.ticked', () => {
      count++
    })
    view.define('weather.alert_raised', z.object({ city: z.string() }))
    bus.removeByPlugin('@keith/tool-weather')
    bus.emit('scheduler.ticked', { at: 1 })
    loose(bus).emit('weather.alert_raised', { city: 1 })
    await bus.idle()
    expect(count).toBe(0)
  })

  test('idle waits for handlers queued by handlers', async () => {
    const { bus } = setup()
    const order: string[] = []
    bus.on('core.started', () => {
      bus.emit('scheduler.ticked', { at: 1 })
    })
    bus.on('scheduler.ticked', async () => {
      await Promise.resolve()
      order.push('tick')
    })
    bus.emit('core.started', { version: '0' })
    await bus.idle()
    expect(order).toEqual(['tick'])
  })
})
