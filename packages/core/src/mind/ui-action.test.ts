import { describe, expect, test } from 'bun:test'
import type { CoreFrame, UiBlock } from '@keith/protocol'
import {
  defineTool,
  isKeithError,
  type KeithErrorCode,
  type ToolAction,
  type ToolRunContext,
} from '@keith/sdk'
import { fakeDelay, fakeText, fakeToolCall } from '@keith/sdk/testing'
import { z } from 'zod'
import type { MessageId, NodeId, ThreadId, Tier } from '../shared/types.ts'
import { createGate, createHarness, type Harness, LAPTOP, PEPPER, PHONE, TONY } from './testing/harness.ts'

function framesOfType<T extends CoreFrame['type']>(h: Harness, node: NodeId, type: T) {
  return h.sink.framesOf(node).filter((f): f is Extract<CoreFrame, { type: T }> => f.type === type)
}

const BUTTONS: UiBlock = {
  type: 'card',
  id: 'venue',
  title: 'Riverside Hall',
  children: [
    {
      type: 'actions',
      id: 'confirm',
      actions: [
        { id: 'book', label: 'Book Riverside', style: 'primary', value: { venue: 'riverside' } },
        { id: 'more', label: 'Show more' },
      ],
    },
  ],
}

type Calls = { action: ToolAction; t: ToolRunContext }[]

function venueTool(opts: {
  minTier?: Tier
  onAction?: ((a: ToolAction, t: ToolRunContext) => Promise<unknown>) | undefined
}) {
  const handler = opts.onAction
  return defineTool({
    name: 'test.venues',
    description: 'venues',
    input: z.object({}),
    minTier: opts.minTier ?? 'guest',
    run: async () => ({ content: 'one venue', ui: BUTTONS }),
    ...(handler
      ? { onAction: async (a: ToolAction, t: ToolRunContext) => (await handler(a, t)) as never }
      : {}),
  })
}

/** Tony asks, the tool shows the card; returns the thread and the reply that carries the block. */
async function showCard(h: Harness): Promise<{ threadId: ThreadId; messageId: MessageId }> {
  const { thread } = await h.open(TONY, LAPTOP)
  await h.open(TONY, PHONE)
  await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: LAPTOP, modality: 'text', text: 'venues?' })
  await h.settle()
  const [completed] = framesOfType(h, PHONE, 'message.completed')
  const messageId = completed?.data.message.id
  if (!messageId) throw new Error('no reply')
  expect(completed?.data.message.ui).toEqual([BUTTONS])
  return { threadId: thread.id, messageId }
}

async function codeOf(p: Promise<unknown>): Promise<KeithErrorCode | 'none'> {
  try {
    await p
    return 'none'
  } catch (error) {
    if (isKeithError(error)) return error.code
    throw error
  }
}

describe('history', () => {
  test('thread.opened history carries the blocks of each reply', async () => {
    const h = await createHarness({
      tools: [venueTool({})],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { messageId } = await showCard(h)
    const reopened = await h.tm.open({ personId: TONY, nodeId: LAPTOP, arrival: null })
    const reply = reopened.messages.find((m) => m.id === messageId)
    expect(reply).toMatchObject({ role: 'assistant', content: 'Here.', ui: [BUTTONS] })
    await h.settle()
  })
})

describe('ui.action', () => {
  test('calls onAction exactly once, for the clicking person, and appends its result', async () => {
    const calls: Calls = []
    const tool = venueTool({
      onAction: async (action, t) => {
        calls.push({ action, t })
        return { content: 'Booked Riverside Hall.', ui: { type: 'markdown', id: 'done', text: '**Booked**' } }
      },
    })
    const h = await createHarness({
      tools: [tool],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { threadId, messageId } = await showCard(h)
    const requests = h.llm.requests.length

    await h.tm.action({
      threadId,
      personId: TONY,
      nodeId: PHONE,
      messageId,
      blockId: 'confirm',
      actionId: 'book',
    })
    await h.settle()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.action).toEqual({
      messageId,
      blockId: 'confirm',
      actionId: 'book',
      value: { venue: 'riverside' },
    })
    expect(calls[0]?.t.person).toEqual({ id: TONY, name: 'Tony', tier: 'owner' })
    expect(calls[0]?.t.threadId).toBe(threadId)
    expect(calls[0]?.t.taskId).toBeNull()
    // No model call: the result is the message.
    expect(h.llm.requests).toHaveLength(requests)
    const completed = framesOfType(h, LAPTOP, 'message.completed').at(-1)
    expect(completed?.data.message).toMatchObject({
      role: 'assistant',
      content: 'Booked Riverside Hall.',
      ui: [{ type: 'markdown', id: 'done', text: '**Booked**' }],
    })
    expect(framesOfType(h, PHONE, 'ui.render').at(-1)?.data).toMatchObject({
      messageId: completed?.data.message.id,
      fallbackText: '**Booked**',
    })
    expect(framesOfType(h, LAPTOP, 'ui.render')).toHaveLength(0)
    // The new block is stored with its tool, so a click on it finds the handler again.
    expect(h.repos.all.messages.at(-1)).toMatchObject({ ui: [{ toolName: 'test.venues' }] })
  })

  test('a result waits for the running turn, so history stays in order', async () => {
    const gate = createGate()
    const tool = venueTool({ onAction: async () => ({ content: 'Booked.' }) })
    const h = await createHarness({
      tools: [tool],
      llmSleep: gate.sleep,
      script: [
        [fakeToolCall('test.venues', {}, 'c1')],
        fakeText('Here.'),
        [...fakeText('Thinking'), fakeDelay(1), ...fakeText('...')],
      ],
    })
    const { threadId, messageId } = await showCard(h)
    await h.tm.input({ threadId, personId: TONY, nodeId: LAPTOP, modality: 'text', text: 'and?' })
    for (let i = 0; i < 50 && gate.waiting === 0; i++) await Bun.sleep(1)
    expect(gate.waiting).toBe(1)
    let done = false
    const clicked = h.tm
      .action({ threadId, personId: TONY, nodeId: PHONE, messageId, blockId: 'confirm', actionId: 'book' })
      .then(() => {
        done = true
      })
    await Bun.sleep(10)
    expect(done).toBe(false)
    gate.release()
    await clicked
    await h.settle()
    const visible = h.repos.all.messages.filter(
      (m) => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls),
    )
    expect(visible.map((m) => m.content).slice(-2)).toEqual(['Thinking...', 'Booked.'])
  })

  test('passes the frame value over the stored one, and undefined adds nothing', async () => {
    const calls: Calls = []
    const tool = venueTool({
      onAction: async (action, t) => {
        calls.push({ action, t })
        return undefined
      },
    })
    const h = await createHarness({
      tools: [tool],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { threadId, messageId } = await showCard(h)
    const stored = h.repos.all.messages.length
    await h.tm.action({
      threadId,
      personId: TONY,
      nodeId: PHONE,
      messageId,
      blockId: 'confirm',
      actionId: 'more',
      value: 3,
    })
    await h.settle()
    expect(calls.map((c) => c.action.value)).toEqual([3])
    expect(h.repos.all.messages).toHaveLength(stored)
  })

  test('a block whose tool has no onAction becomes the input "(clicked: <label>)"', async () => {
    const h = await createHarness({
      tools: [venueTool({})],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.'), fakeText('Booking it.')],
    })
    const { threadId, messageId } = await showCard(h)
    await h.tm.action({
      threadId,
      personId: TONY,
      nodeId: PHONE,
      messageId,
      blockId: 'confirm',
      actionId: 'book',
    })
    await h.settle()
    const user = h.repos.all.messages.filter((m) => m.role === 'user').at(-1)
    expect(user).toMatchObject({ content: '(clicked: Book Riverside)', authorPersonId: TONY, nodeId: PHONE })
    expect(h.llm.requests.at(-1)?.messages.at(-1)).toEqual({
      role: 'user',
      content: '(clicked: Book Riverside)',
    })
    // The clicking node gets the echo too: it never typed the text.
    expect(framesOfType(h, PHONE, 'message.user').map((f) => f.data.message.content)).toContain(
      '(clicked: Book Riverside)',
    )
    expect(framesOfType(h, PHONE, 'message.completed').at(-1)?.data.message.content).toBe('Booking it.')
  })

  test('unknown message, block, action or non-actions block → NOT_FOUND', async () => {
    const h = await createHarness({
      tools: [venueTool({ onAction: async () => undefined })],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { threadId, messageId } = await showCard(h)
    const base = { threadId, personId: TONY, nodeId: PHONE, messageId, blockId: 'confirm', actionId: 'book' }
    const userMessage = h.repos.all.messages.find((m) => m.role === 'user')?.id
    if (!userMessage) throw new Error('no user message')
    expect(await codeOf(h.tm.action({ ...base, messageId: 'msg_00000000000000000000000999' }))).toBe(
      'NOT_FOUND',
    )
    expect(await codeOf(h.tm.action({ ...base, messageId: userMessage }))).toBe('NOT_FOUND')
    expect(await codeOf(h.tm.action({ ...base, blockId: 'nope' }))).toBe('NOT_FOUND')
    expect(await codeOf(h.tm.action({ ...base, blockId: 'venue' }))).toBe('NOT_FOUND')
    expect(await codeOf(h.tm.action({ ...base, actionId: 'nope' }))).toBe('NOT_FOUND')
    await h.settle()
  })

  test('tier and participation are checked against the clicking person', async () => {
    let calls = 0
    const h = await createHarness({
      tools: [
        venueTool({
          minTier: 'owner',
          onAction: async () => {
            calls++
            return undefined
          },
        }),
      ],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { threadId, messageId } = await showCard(h)
    const base = { threadId, nodeId: PHONE, messageId, blockId: 'confirm', actionId: 'book' }
    // Pepper is not in Tony's thread.
    expect(await codeOf(h.tm.action({ ...base, personId: PEPPER }))).toBe('FORBIDDEN')
    // Tony becomes a member: the owner-only tool refuses him.
    const tony = await h.repos.persons.get(TONY)
    if (!tony) throw new Error('no tony')
    await h.repos.persons.create({ ...tony, tier: 'member' })
    expect(await codeOf(h.tm.action({ ...base, personId: TONY }))).toBe('FORBIDDEN')
    expect(calls).toBe(0)
    await h.settle()
  })

  test('a throwing onAction rejects, so the server can send an error frame', async () => {
    const h = await createHarness({
      tools: [
        venueTool({
          onAction: async () => {
            throw new Error('boom')
          },
        }),
      ],
      script: [[fakeToolCall('test.venues', {}, 'c1')], fakeText('Here.')],
    })
    const { threadId, messageId } = await showCard(h)
    const stored = h.repos.all.messages.length
    let error: unknown
    try {
      await h.tm.action({
        threadId,
        personId: TONY,
        nodeId: PHONE,
        messageId,
        blockId: 'confirm',
        actionId: 'book',
      })
    } catch (e) {
      error = e
    }
    expect(String(error)).toContain('boom')
    expect(h.repos.all.messages).toHaveLength(stored)
    await h.settle()
  })
})

describe('ui block validation (I-9)', () => {
  test('an invalid block is dropped with a warning and the turn goes on', async () => {
    const bad = defineTool({
      name: 'test.bad',
      description: 'bad',
      input: z.object({}),
      minTier: 'guest',
      run: async () => ({
        content: 'ok',
        ui: { type: 'image', id: 'pic', url: 'http://insecure.example/a.png', alt: 'a' },
      }),
    })
    const h = await createHarness({
      tools: [bad],
      script: [[fakeToolCall('test.bad', {}, 'c1')], fakeText('Done.')],
    })
    const { thread } = await h.open(TONY, PHONE)
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: PHONE, modality: 'text', text: 'go' })
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(0)
    const completed = framesOfType(h, PHONE, 'message.completed').at(-1)
    expect(completed?.data.message.content).toBe('Done.')
    expect(completed?.data.message.ui).toBeUndefined()
    expect(h.log.entries.some((r) => r.level === 'warn' && r.msg.includes('invalid ui block'))).toBe(true)
  })

  test('a block too deep or too large is dropped', async () => {
    const deep: UiBlock = {
      type: 'stack',
      id: 's1',
      direction: 'vertical',
      children: [
        {
          type: 'stack',
          id: 's2',
          direction: 'vertical',
          children: [
            {
              type: 'stack',
              id: 's3',
              direction: 'vertical',
              children: [
                {
                  type: 'stack',
                  id: 's4',
                  direction: 'vertical',
                  children: [{ type: 'markdown', id: 'm', text: 'x' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const big: UiBlock = { type: 'markdown', id: 'big', text: 'x'.repeat(300 * 1024) }
    const blocks = [deep, big]
    const tool = defineTool({
      name: 'test.limits',
      description: 'limits',
      input: z.object({ n: z.number() }),
      minTier: 'guest',
      run: async ({ n }) => ({ content: 'ok', ui: blocks[n] as UiBlock }),
    })
    const h = await createHarness({
      tools: [tool],
      script: [
        [fakeToolCall('test.limits', { n: 0 }, 'c1'), fakeToolCall('test.limits', { n: 1 }, 'c2')],
        fakeText('Done.'),
      ],
    })
    const { thread } = await h.open(TONY, PHONE)
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: PHONE, modality: 'text', text: 'go' })
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(0)
  })

  test('a second block reusing a block id of the same message is dropped', async () => {
    const tool = defineTool({
      name: 'test.same',
      description: 'same id',
      input: z.object({}),
      minTier: 'guest',
      run: async () => ({ content: 'ok', ui: { type: 'markdown', id: 'dup', text: 'x' } }),
    })
    const h = await createHarness({
      tools: [tool],
      script: [[fakeToolCall('test.same', {}, 'c1'), fakeToolCall('test.same', {}, 'c2')], fakeText('Done.')],
    })
    const { thread } = await h.open(TONY, PHONE)
    await h.tm.input({ threadId: thread.id, personId: TONY, nodeId: PHONE, modality: 'text', text: 'go' })
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(1)
    expect(framesOfType(h, PHONE, 'message.completed').at(-1)?.data.message.ui).toHaveLength(1)
  })
})
