import { describe, expect, test } from 'bun:test'
import { isKeithError } from '@keith/sdk'
import { seedPerson } from './testing/fakes.ts'
import { createHarness } from './testing/harness.ts'

const owner = (pluginId: string) => ({ pluginId, namespace: 'weather', kind: 'tool' as const })

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('delivery queue', () => {
  test('enqueue persists with defaults (main thread, core, normal) and emits delivery.enqueued', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const d = await h.deliveries.enqueue({ personId: tony.personId, kind: 'task_result', content: 'done' })
    expect(d).toMatchObject({
      threadId: tony.threadId,
      source: 'core',
      urgency: 'normal',
      authorPersonId: null,
      ui: null,
      status: 'pending',
      createdAt: h.clock.now(),
      deliveredAt: null,
    })
    expect(h.repos.deliveryRows.get(d.id)).toEqual(d)
    expect(h.events.of('delivery.enqueued')).toEqual([
      { deliveryId: d.id, threadId: tony.threadId, kind: 'task_result', urgency: 'normal' },
    ])
  })

  test('enqueue without a thread fails with NOT_FOUND when the person has no main thread', async () => {
    const h = createHarness()
    const error = await rejection(
      h.deliveries.enqueue({ personId: h.ids.next('per'), kind: 'plugin', content: 'x' }),
    )
    expect(isKeithError(error, 'NOT_FOUND')).toBe(true)
    expect(h.events.of('delivery.enqueued')).toEqual([])
  })

  test('pendingFor orders by urgency, then age', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const add = async (content: string, urgency: 'low' | 'normal' | 'high' | 'critical') => {
      h.clock.advance(1)
      return h.deliveries.enqueue({ personId: tony.personId, kind: 'plugin', content, urgency })
    }
    await add('low', 'low')
    await add('normal-1', 'normal')
    await add('critical', 'critical')
    await add('normal-2', 'normal')
    await add('high', 'high')
    const pending = await h.deliveries.pendingFor(tony.threadId)
    expect(pending.map((d) => d.content)).toEqual(['critical', 'high', 'normal-1', 'normal-2', 'low'])
  })

  test('markDelivered marks pending items once and emits delivery.delivered for each', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const a = await h.deliveries.enqueue({ personId: tony.personId, kind: 'plugin', content: 'a' })
    const b = await h.deliveries.enqueue({ personId: tony.personId, kind: 'plugin', content: 'b' })
    const messageId = h.ids.next('msg')
    h.clock.advance(5)
    await h.deliveries.markDelivered([a.id, b.id], messageId)
    await h.deliveries.markDelivered([a.id], h.ids.next('msg'))
    await h.deliveries.markDelivered([], messageId)
    expect(await h.deliveries.pendingFor(tony.threadId)).toEqual([])
    expect(h.repos.deliveryRows.get(a.id)).toMatchObject({ status: 'delivered', deliveredAt: h.clock.now() })
    expect(h.events.of('delivery.delivered')).toEqual([
      { deliveryId: a.id, threadId: tony.threadId, messageId },
      { deliveryId: b.id, threadId: tony.threadId, messageId },
    ])
  })
})

describe('plugin delivery sink', () => {
  test('enqueues a plugin delivery with source = plugin id', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const sink = h.deliverySinks.forPlugin(owner('@keith/tool-weather'))
    const { deliveryId } = await sink.enqueue({
      personId: tony.personId,
      text: 'rain at 4pm',
      urgency: 'high',
    })
    expect(h.repos.deliveryRows.get(deliveryId)).toMatchObject({
      kind: 'plugin',
      source: '@keith/tool-weather',
      urgency: 'high',
      content: 'rain at 4pm',
      threadId: tony.threadId,
    })
    expect(h.events.of('delivery.enqueued')).toHaveLength(1)
  })

  test('rejects invalid input at the plugin boundary', async () => {
    const h = createHarness()
    const sink = h.deliverySinks.forPlugin(owner('@keith/tool-weather'))
    const error = await rejection(sink.enqueue({ personId: 'tony', text: 'x' }))
    expect(isKeithError(error, 'TOOL_INPUT_INVALID')).toBe(true)
    expect(h.repos.deliveryRows.size).toBe(0)
  })

  test("refuses a thread the person doesn't participate in", async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const pepper = await seedPerson(h.repos, h.ids, { name: 'Pepper' })
    const sink = h.deliverySinks.forPlugin(owner('@keith/tool-weather'))
    const error = await rejection(
      sink.enqueue({ personId: tony.personId, text: 'x', threadId: pepper.threadId }),
    )
    expect(isKeithError(error, 'FORBIDDEN')).toBe(true)
    const ok = await sink.enqueue({ personId: tony.personId, text: 'x', threadId: tony.threadId })
    expect(ok.deliveryId.startsWith('dlv_')).toBe(true)
  })

  test('a removed plugin can no longer enqueue', async () => {
    const h = createHarness()
    const tony = await seedPerson(h.repos, h.ids, { name: 'Tony' })
    const sink = h.deliverySinks.forPlugin(owner('@keith/tool-weather'))
    h.deliverySinks.removeByPlugin('@keith/tool-weather')
    const error = await rejection(sink.enqueue({ personId: tony.personId, text: 'x' }))
    expect(isKeithError(error, 'FORBIDDEN')).toBe(true)
  })
})
