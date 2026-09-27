// UI blocks on delivered items (plugin deliveries, task results) and history order by `seq`.

import { describe, expect, test } from 'bun:test'
import { type CoreFrame, type UiBlock, uiBlockToText } from '@keith/protocol'
import { defineTool, ProviderError } from '@keith/sdk'
import { fakeText, fakeToolCall } from '@keith/sdk/testing'
import { z } from 'zod'
import type { NodeId, ThreadId } from '../shared/types.ts'
import { createHarness, type Harness, LAPTOP, PHONE, TONY } from './testing/harness.ts'

function framesOfType<T extends CoreFrame['type']>(h: Harness, node: NodeId, type: T) {
  return h.sink.framesOf(node).filter((f): f is Extract<CoreFrame, { type: T }> => f.type === type)
}

const RAIN: UiBlock = {
  type: 'card',
  id: 'rain',
  title: 'Rain at 4pm',
  children: [{ type: 'actions', id: 'rain-actions', actions: [{ id: 'umbrella', label: 'Remind me' }] }],
}

const SHORTLIST: UiBlock = { type: 'list', id: 'shortlist', items: [{ title: 'Riverside Hall' }] }

/** LAPTOP is text-only (`chat.text@1`), PHONE also renders blocks (`ui.render@1`). */
async function openBoth(h: Harness): Promise<ThreadId> {
  const { thread } = await h.open(TONY, LAPTOP)
  await h.open(TONY, PHONE)
  await h.settle()
  return thread.id
}

describe('delivery ui (C5)', () => {
  test('a plugin delivery card is rendered, stored on the delivering message and in history', async () => {
    const h = await createHarness({ script: [fakeText('Sir, rain is coming.')] })
    const threadId = await openBoth(h)
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: '@keith/tool-weather',
      content: 'rain at 4pm',
      ui: RAIN,
    })
    await h.settle()

    const [started] = framesOfType(h, PHONE, 'message.started')
    const messageId = started?.data.messageId ?? 'msg_missing'
    expect(started?.data.proactive).toBe(true)
    // The web-like node gets `ui.render` with the fallback text; the text-only node gets none.
    expect(framesOfType(h, PHONE, 'ui.render').map((f) => f.data)).toEqual([
      { threadId, messageId, block: RAIN, fallbackText: uiBlockToText(RAIN) },
    ])
    expect(framesOfType(h, LAPTOP, 'ui.render')).toHaveLength(0)
    // Both get the completed message with its blocks (the text-only node shows their fallback).
    for (const node of [LAPTOP, PHONE]) {
      const [completed] = framesOfType(h, node, 'message.completed')
      expect(completed?.data.message).toMatchObject({
        id: messageId,
        content: 'Sir, rain is coming.',
        ui: [RAIN],
      })
    }
    // `ui.render` comes before `message.completed`, as with tool blocks.
    const types = h.sink.framesOf(PHONE).map((f) => f.type)
    expect(types.indexOf('ui.render')).toBeLessThan(types.indexOf('message.completed'))

    expect(h.repos.all.messages.at(-1)).toMatchObject({
      id: messageId,
      ui: [
        {
          block: RAIN,
          toolCallId: `delivery:${h.deliveries.all[0]?.id}`,
          toolName: 'delivery:@keith/tool-weather',
        },
      ],
    })
    expect(h.deliveries.marked).toEqual([{ ids: [h.deliveries.all[0]?.id ?? 'dlv_missing'], messageId }])

    const reopened = await h.open(TONY, PHONE)
    expect(reopened.messages.at(-1)).toMatchObject({ id: messageId, ui: [RAIN] })
    h.tm.stop()
  })

  test("a task result's ui reaches the delivered message", async () => {
    const h = await createHarness({ script: [fakeText('The shortlist is ready.')] })
    await openBoth(h)
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'task_result',
      content: 'Shortlist: Riverside',
      ui: SHORTLIST,
    })
    await h.settle()
    const [completed] = framesOfType(h, PHONE, 'message.completed')
    expect(completed?.data.message.ui).toEqual([SHORTLIST])
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(1)
    expect(h.repos.all.messages.at(-1)).toMatchObject({ ui: [{ toolName: 'delivery:core' }] })
    h.tm.stop()
  })

  test('the first turn after an arrival carries the blocks of the items it delivers', async () => {
    const h = await createHarness({ script: [fakeText('Morning, sir. Rain at 4.')] })
    const { thread } = await h.open(TONY, PHONE)
    await h.settle()
    h.presence.set(TONY, false)
    h.sink.detach(PHONE)
    h.tm.detach({ nodeId: PHONE })
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: 'weather',
      content: 'rain',
      ui: RAIN,
    })
    await h.settle()
    await h.open(TONY, PHONE, { awayMs: 8 * 3_600_000 })
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: PHONE, modality: 'text', text: 'hello' })
    await h.settle()
    const [completed] = framesOfType(h, PHONE, 'message.completed')
    expect(completed?.data.message).toMatchObject({ role: 'assistant', ui: [RAIN] })
    expect(h.deliveries.marked).toEqual([
      {
        ids: [h.deliveries.all[0]?.id ?? 'dlv_missing'],
        messageId: completed?.data.message.id ?? 'msg_missing',
      },
    ])
    h.tm.stop()
  })

  test('a failed delivery turn attaches no block; the next flush delivers it once', async () => {
    const h = await createHarness({
      script: [
        () => {
          throw new ProviderError('auth', 'bad key')
        },
        fakeText('Rain at 4, sir.'),
      ],
    })
    await openBoth(h)
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: 'weather',
      content: 'rain',
      ui: RAIN,
    })
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(0)
    expect(h.repos.all.messages.at(-1)).toMatchObject({ ui: null })
    expect(h.deliveries.marked).toEqual([])

    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: 'weather',
      content: 'wind',
      ui: null,
    })
    await h.settle()
    const renders = framesOfType(h, PHONE, 'ui.render')
    expect(renders.map((f) => f.data.block)).toEqual([RAIN])
    expect(h.repos.all.messages.at(-1)).toMatchObject({ content: 'Rain at 4, sir.', ui: [{ block: RAIN }] })
    h.tm.stop()
  })

  test('a block that reuses a block id of the message is dropped with a warning', async () => {
    const h = await createHarness({ script: [fakeText('Two updates.')] })
    await openBoth(h)
    const other: UiBlock = { type: 'markdown', id: 'rain', text: 'same id' }
    await h.deliveries.enqueue({ personId: TONY, kind: 'plugin', source: 'a', content: 'one', ui: RAIN })
    await h.deliveries.enqueue({ personId: TONY, kind: 'plugin', source: 'b', content: 'two', ui: other })
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render').map((f) => f.data.block)).toEqual([RAIN])
    expect(h.log.entries.some((e) => e.msg.includes('delivery ui block reuses a block id'))).toBe(true)
    // Both items were in context and are delivered.
    expect(h.deliveries.marked[0]?.ids).toHaveLength(2)
    h.tm.stop()
  })

  test('a click on a delivered block becomes the input "(clicked: <label>)"', async () => {
    const h = await createHarness({ script: [fakeText('Rain at 4.'), fakeText('Reminder set.')] })
    const threadId = await openBoth(h)
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: 'weather',
      content: 'rain',
      ui: RAIN,
    })
    await h.settle()
    const [completed] = framesOfType(h, PHONE, 'message.completed')
    await h.tm.action({
      threadId,
      personId: TONY,
      nodeId: PHONE,
      messageId: completed?.data.message.id ?? 'msg_missing',
      blockId: 'rain-actions',
      actionId: 'umbrella',
    })
    await h.settle()
    const users = h.repos.all.messages.filter((m) => m.role === 'user')
    expect(users.map((m) => m.content)).toEqual(['(clicked: Remind me)'])
    h.tm.stop()
  })
})

describe('history order (seq)', () => {
  test('follows insert order without restamping createdAt', async () => {
    const echo = defineTool({
      name: 'test.echo',
      description: 'echo',
      input: z.object({ text: z.string() }),
      minTier: 'guest',
      run: async ({ text }) => ({ content: text }),
    })
    const h = await createHarness({
      tools: [echo],
      script: [[fakeToolCall('test.echo', { text: 'x' })], fakeText('first'), fakeText('second')],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    // The clock never moves: every row has the same createdAt, and the reply's id is older than
    // its tool rows' ids. Only `seq` keeps the order.
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: LAPTOP, modality: 'text', text: 'go' })
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: LAPTOP, modality: 'text', text: 'again' })
    await h.settle()
    const now = h.clock.now()
    const rows = h.repos.all.messages
    expect(rows.every((m) => m.createdAt === now)).toBe(true)
    expect(rows.map((m) => m.seq)).toEqual(rows.map((_, i) => i + 1))
    const reopened = await h.open(TONY, PHONE)
    expect(reopened.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'go'],
      ['assistant', 'first'],
      ['user', 'again'],
      ['assistant', 'second'],
    ])
    h.tm.stop()
  })
})
