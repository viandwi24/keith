import { afterEach, describe, expect, jest, test } from 'bun:test'
import { type CoreFrame, CoreFrame as CoreFrameSchema } from '@keith/protocol'
import { defineTool, ProviderError } from '@keith/sdk'
import { fakeDelay, fakeText, fakeToolCall } from '@keith/sdk/testing'
import { z } from 'zod'
import type { NodeId } from '../shared/types.ts'
import {
  advance,
  createGate,
  createHarness,
  flushMicrotasks,
  type Harness,
  LAPTOP,
  PEPPER,
  PEPPER_PHONE,
  PHONE,
  TONY,
} from './testing/harness.ts'
import { APOLOGY_TEXT } from './thread-manager.ts'

afterEach(() => {
  jest.useRealTimers()
})

function framesOfType<T extends CoreFrame['type']>(h: Harness, node: NodeId, type: T) {
  return h.sink.framesOf(node).filter((f): f is Extract<CoreFrame, { type: T }> => f.type === type)
}

function say(h: Harness, threadId: string, text: string, nodeId: NodeId = LAPTOP, personId = TONY) {
  return h.tm.input({ threadId: threadId as `thr_${string}`, personId, nodeId, modality: 'text', text })
}

/** Opens Tony's thread, then leaves him away with no node attached. */
async function tonyAway(h: Harness) {
  const { thread } = await h.open(TONY, LAPTOP)
  await h.settle()
  h.presence.set(TONY, false)
  h.sink.detach(LAPTOP)
  h.tm.detach({ nodeId: LAPTOP })
  return thread.id
}

describe('open', () => {
  test('creates the main thread once, with its participant, and emits thread.opened', async () => {
    const h = await createHarness()
    const first = await h.open(TONY, LAPTOP)
    const second = await h.open(TONY, PHONE)
    expect(first.thread.id).toBe(second.thread.id)
    expect(h.repos.all.threads).toHaveLength(1)
    expect(h.repos.all.threads[0]?.slug).toBe('main')
    expect(first.thread.participants).toEqual([{ id: TONY, name: 'Tony', tier: 'owner' }])
    expect(first.thread.state).toBe('idle')
    expect(h.bus.named('thread.opened')).toHaveLength(2)
    await h.settle()
  })

  test('returns history without tool rows or intermediate tool-call messages', async () => {
    const echo = defineTool({
      name: 'test.echo',
      description: 'echo',
      input: z.object({ text: z.string() }),
      minTier: 'guest',
      run: async ({ text }) => ({ content: text }),
    })
    const h = await createHarness({
      tools: [echo],
      script: [[fakeToolCall('test.echo', { text: 'x' })], fakeText('done')],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await say(h, thread.id, 'go')
    await h.settle()
    const reopened = await h.open(TONY, PHONE)
    expect(reopened.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'go'],
      ['assistant', 'done'],
    ])
    await h.settle()
  })

  test('refuses a thread the person is not part of', async () => {
    const h = await createHarness()
    const { thread } = await h.open(TONY, LAPTOP)
    let caught: unknown
    try {
      await h.tm.open({ personId: PEPPER, nodeId: PEPPER_PHONE, threadId: thread.id, arrival: null })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'FORBIDDEN' })
    await h.settle()
  })
})

describe('user turns', () => {
  test('streams frames in order: thinking, started, speaking, deltas, completed, idle', async () => {
    const h = await createHarness({ script: [fakeText('Hello sir.', 3)] })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await say(h, thread.id, 'hi')
    await h.settle()
    expect(h.sink.typesOf(LAPTOP)).toEqual([
      'thread.state(thinking)',
      'message.started',
      'thread.state(speaking)',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.completed',
      'thread.state(idle)',
    ])
    for (const f of h.sink.framesOf(LAPTOP)) expect(CoreFrameSchema.safeParse(f).success).toBe(true)
    const [started] = framesOfType(h, LAPTOP, 'message.started')
    expect(started?.data.proactive).toBe(false)
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message).toMatchObject({
      content: 'Hello sir.',
      role: 'assistant',
      authorPersonId: null,
    })
    expect(completed?.data.message.id).toBe(started?.data.messageId)
    expect(h.scheduler.lanes).toEqual(['foreground'])
    expect(h.repos.all.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello sir.'],
    ])
    expect(h.bus.named('turn.completed')).toMatchObject([{ steps: 1, cancelled: false }])
    expect(h.tm.state(thread.id)).toBe('idle')
  })

  test('runs a tool loop and feeds the result back; a tool error becomes a tool result', async () => {
    const echo = defineTool({
      name: 'test.echo',
      description: 'echo',
      input: z.object({ text: z.string() }),
      minTier: 'guest',
      run: async ({ text }) => ({ content: `echo: ${text}` }),
    })
    const boom = defineTool({
      name: 'test.boom',
      description: 'fails',
      input: z.object({}),
      minTier: 'guest',
      run: async () => {
        throw new Error('kaput')
      },
    })
    const h = await createHarness({
      tools: [echo, boom],
      script: [
        [fakeToolCall('test.echo', { text: 'x' }, 'c1'), fakeToolCall('test.boom', {}, 'c2')],
        fakeText('All done.'),
      ],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await say(h, thread.id, 'use tools')
    await h.settle()

    const second = h.llm.requests[1]
    expect(second?.messages.slice(-3)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'test.echo', args: { text: 'x' } },
          { id: 'c2', name: 'test.boom', args: {} },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'echo: x' },
      { role: 'tool', toolCallId: 'c2', content: 'Tool test.boom failed: kaput' },
    ])
    const activity = framesOfType(h, LAPTOP, 'tool.activity').map((f) => [f.data.toolCallId, f.data.status])
    expect(activity).toEqual([
      ['c1', 'started'],
      ['c2', 'started'],
      ['c1', 'completed'],
      ['c2', 'failed'],
    ])
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message.content).toBe('All done.')
    expect(h.repos.all.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ])
  })

  test('queues input while speaking and runs it next with both user messages in context', async () => {
    const gate = createGate()
    const h = await createHarness({
      llmSleep: gate.sleep,
      script: [[...fakeText('One'), fakeDelay(1), ...fakeText(' done')], fakeText('Two')],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await say(h, thread.id, 'first')
    await flushMicrotasks()
    expect(h.tm.state(thread.id)).toBe('speaking')
    await say(h, thread.id, 'second')
    await flushMicrotasks()
    expect(h.llm.calls).toBe(1)
    gate.release()
    await h.settle()
    expect(h.llm.calls).toBe(2)
    expect(h.llm.requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'One done' },
      { role: 'user', content: 'second' },
    ])
    expect(h.bus.named('turn.started')).toHaveLength(2)
  })

  test('input.cancel stops streaming and persists the partial text as cancelled', async () => {
    const gate = createGate()
    const h = await createHarness({
      llmSleep: gate.sleep,
      script: [[...fakeText('Partial'), fakeDelay(1), ...fakeText(' rest')]],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await say(h, thread.id, 'tell me a story')
    await flushMicrotasks()
    expect(gate.waiting).toBe(1)
    h.tm.cancel({ threadId: thread.id, nodeId: LAPTOP })
    await h.settle()
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message).toMatchObject({ content: 'Partial', meta: { cancelled: true } })
    const stored = h.repos.all.messages.at(-1)
    expect(stored).toMatchObject({ role: 'assistant', content: 'Partial', meta: { cancelled: true } })
    expect(h.sink.typesOf(LAPTOP).at(-1)).toBe('thread.state(idle)')
    expect(h.bus.named('turn.completed')).toMatchObject([{ cancelled: true }])
  })

  test('I-7: a second attached node gets the message.user echo and all text frames; focus follows input', async () => {
    const h = await createHarness({ script: [fakeText('A'), fakeText('B')] })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.open(TONY, PHONE)
    await h.settle()
    await say(h, thread.id, 'from laptop', LAPTOP)
    await h.settle()
    expect(h.sink.typesOf(PHONE)).toEqual([
      'message.user',
      'thread.state(thinking)',
      'message.started',
      'thread.state(speaking)',
      'message.delta',
      'message.completed',
      'thread.state(idle)',
    ])
    expect(h.sink.typesOf(LAPTOP)).not.toContain('message.user')
    const [echo] = framesOfType(h, PHONE, 'message.user')
    expect(echo?.data.message).toMatchObject({ content: 'from laptop', authorPersonId: TONY, role: 'user' })

    await say(h, thread.id, 'from phone', PHONE)
    await h.settle()
    expect(framesOfType(h, LAPTOP, 'message.user').map((f) => f.data.message.content)).toEqual(['from phone'])
    // Focus is visible in the "Now" section: the phone can render UI, the laptop cannot.
    expect(h.llm.requests[0]?.system).not.toContain('ui.render@1')
    expect(h.llm.requests[1]?.system).toContain('ui.render@1')
  })

  test('ui blocks go as ui.render only to nodes with ui.render@1 and are stored on the reply', async () => {
    const card = defineTool({
      name: 'test.card',
      description: 'card',
      input: z.object({}),
      minTier: 'guest',
      run: async () => ({ content: 'shown', ui: { type: 'markdown', id: 'b1', text: '**Venues**' } }),
    })
    const h = await createHarness({
      tools: [card],
      script: [[fakeToolCall('test.card', {}, 'u1')], fakeText('Here.')],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.open(TONY, PHONE)
    await say(h, thread.id, 'show me')
    await h.settle()
    expect(framesOfType(h, PHONE, 'ui.render')).toHaveLength(1)
    expect(framesOfType(h, LAPTOP, 'ui.render')).toHaveLength(0)
    const [completed] = framesOfType(h, PHONE, 'message.completed')
    expect(completed?.data.message.ui).toEqual([{ type: 'markdown', id: 'b1', text: '**Venues**' }])
    expect(h.repos.all.messages.at(-1)).toMatchObject({ ui: [{ toolCallId: 'u1', toolName: 'test.card' }] })
  })

  test('a provider failure sends an error frame and an apology message', async () => {
    const h = await createHarness({
      script: [
        () => {
          throw new ProviderError('auth', 'bad key')
        },
      ],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await say(h, thread.id, 'hi')
    await h.settle()
    const [error] = framesOfType(h, LAPTOP, 'error')
    expect(error?.data.code).toBe('PROVIDER_ERROR')
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message.content).toBe(APOLOGY_TEXT)
    expect(h.bus.named('turn.failed')).toMatchObject([{ code: 'PROVIDER_ERROR' }])
    expect(h.tm.state(thread.id)).toBe('idle')
  })
})

describe('deliveries', () => {
  test('I-11 / S-2: a delivery enqueued while idle and present starts a proactive message without input', async () => {
    const h = await createHarness({ script: [fakeText('Sir, the venue shortlist is ready.')] })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'Venue shortlist: A, B, C' })
    await h.settle()
    const [started] = framesOfType(h, LAPTOP, 'message.started')
    expect(started?.data).toMatchObject({ threadId: thread.id, proactive: true })
    expect(h.scheduler.lanes).toEqual(['delivery'])
    expect(h.llm.requests[0]?.system).toContain('Venue shortlist: A, B, C')
    expect(h.deliveries.marked).toEqual([
      {
        ids: [h.deliveries.all[0]?.id ?? 'dlv_missing'],
        messageId: started?.data.messageId ?? 'msg_missing',
      },
    ])
    expect(h.repos.all.messages.at(-1)).toMatchObject({ role: 'assistant', meta: { proactive: true } })
    expect(h.llm.calls).toBe(1)
  })

  test('a delivery waits while the person is away', async () => {
    const h = await createHarness({ fallback: fakeText('x') })
    await tonyAway(h)
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'done' })
    await h.settle()
    expect(h.llm.calls).toBe(0)
  })

  test('S-1: on-greeting arrival holds deliveries for the reply to "hello" and marks them with its id', async () => {
    const h = await createHarness({ script: [fakeText('Good morning, sir. The shortlist is ready.')] })
    const threadId = await tonyAway(h)
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'Venue shortlist: A, B' })
    await h.settle()
    await h.open(TONY, LAPTOP, { awayMs: 8 * 3_600_000 })
    await h.settle()
    expect(h.llm.calls).toBe(0)

    await say(h, threadId, 'hello')
    await h.settle()
    expect(h.llm.calls).toBe(1)
    expect(h.llm.requests[0]?.system).toContain('Venue shortlist: A, B')
    expect(h.llm.requests[0]?.system).toContain('lead with these items')
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message.meta).toBeUndefined()
    expect(h.deliveries.marked).toEqual([
      {
        ids: [h.deliveries.all[0]?.id ?? 'dlv_missing'],
        messageId: completed?.data.message.id ?? 'msg_missing',
      },
    ])
    expect(h.scheduler.lanes).toEqual(['foreground'])
    h.tm.stop()
  })

  test('the on-greeting hold times out after holdMs, then a normal delivery turn runs', async () => {
    const h = await createHarness({ script: [fakeText('While you were out: done.')], mind: {} })
    await tonyAway(h)
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'done' })
    await h.settle()
    jest.useFakeTimers()
    await h.open(TONY, LAPTOP, { awayMs: null })
    await advance(h.clock, h.config.mind.arrival.holdMs - 1)
    expect(h.llm.calls).toBe(0)
    await advance(h.clock, 1)
    await flushMicrotasks()
    expect(h.llm.calls).toBe(1)
    const [started] = framesOfType(h, LAPTOP, 'message.started')
    expect(started?.data.proactive).toBe(true)
    expect(h.deliveries.all[0]?.status).toBe('delivered')
  })

  test('auto briefing runs a briefing turn after the grace period', async () => {
    const h = await createHarness({
      script: [fakeText('Welcome back, sir.')],
      mind: {
        arrival: { awayAfterMinutes: 30, briefing: 'auto', holdMs: 120_000, graceMs: 1_500 },
      },
    })
    await tonyAway(h)
    jest.useFakeTimers()
    await h.open(TONY, LAPTOP, { awayMs: 5_000_000 })
    // A plugin delivery landing during the grace period does not start its own turn.
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      source: '@keith/tool-news',
      content: '3 headlines',
    })
    await advance(h.clock, 1_499)
    expect(h.llm.calls).toBe(0)
    await advance(h.clock, 1)
    await flushMicrotasks()
    expect(h.llm.calls).toBe(1)
    expect(h.llm.requests[0]?.system).toContain('Greet them')
    expect(h.llm.requests[0]?.system).toContain('3 headlines')
    expect(h.scheduler.lanes).toEqual(['delivery'])
    expect(h.bus.named('turn.started')).toMatchObject([{ kind: 'briefing' }])
    expect(h.deliveries.all[0]?.status).toBe('delivered')
  })

  test('briefing off flushes normally on arrival', async () => {
    const h = await createHarness({
      script: [fakeText('One thing: done.')],
      mind: { arrival: { awayAfterMinutes: 30, briefing: 'off', holdMs: 120_000, graceMs: 1_500 } },
    })
    await tonyAway(h)
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'done' })
    await h.open(TONY, LAPTOP, { awayMs: 9_000_000 })
    await h.settle()
    expect(h.bus.named('turn.started')).toMatchObject([{ kind: 'delivery' }])
  })

  test('open without arrival and with pending deliveries runs a delivery turn right away', async () => {
    const h = await createHarness({ script: [fakeText('By the way: done.')] })
    await tonyAway(h)
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'done' })
    await h.settle()
    expect(h.llm.calls).toBe(0)
    await h.open(TONY, LAPTOP, null)
    await h.settle()
    expect(h.llm.calls).toBe(1)
    expect(framesOfType(h, LAPTOP, 'message.started')[0]?.data.proactive).toBe(true)
    // thread.opened is the server's to send; the delivery turn waits for the next macrotask.
    expect(h.sink.typesOf(LAPTOP)[0]).toBe('thread.state(thinking)')
  })

  test('critical deliveries flush before queued user input', async () => {
    const gate = createGate()
    const h = await createHarness({
      llmSleep: gate.sleep,
      script: [[...fakeText('Hm'), fakeDelay(1)], fakeText('ALERT'), fakeText('Answer')],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await say(h, thread.id, 'first')
    await flushMicrotasks()
    await say(h, thread.id, 'second')
    await h.deliveries.enqueue({
      personId: TONY,
      kind: 'plugin',
      urgency: 'critical',
      content: 'Reactor breach',
    })
    await h.bus.idle()
    gate.release()
    await h.settle()
    expect(h.bus.named('turn.started').map((t) => t.kind)).toEqual(['user', 'delivery', 'user'])
    expect(h.llm.requests[1]?.system).toContain('Reactor breach')
  })
})

describe('concurrency', () => {
  test('S-4: two persons in two threads stream concurrently', async () => {
    const turn = [...fakeText('a'), fakeDelay(100), ...fakeText('b')]
    const h = await createHarness({ fallback: turn })
    const tony = await h.open(TONY, LAPTOP)
    const pepper = await h.open(PEPPER, PEPPER_PHONE)
    await h.settle()
    jest.useFakeTimers()
    await say(h, tony.thread.id, 'work A', LAPTOP, TONY)
    await say(h, pepper.thread.id, 'work B', PEPPER_PHONE, PEPPER)
    await advance(h.clock, 100)
    await flushMicrotasks()
    // Each turn needs 100 ms; both finished after 100 ms in total, less than the sum.
    expect(framesOfType(h, LAPTOP, 'message.completed')[0]?.data.message.content).toBe('ab')
    expect(framesOfType(h, PEPPER_PHONE, 'message.completed')[0]?.data.message.content).toBe('ab')
    expect(h.scheduler.maxConcurrent).toBe(2)
    expect(h.llm.requests.map((r) => r.system.includes('Pepper'))).toEqual([false, true])
  })
})

describe('stall watchdog', () => {
  test('aborts a silent step and reports it', async () => {
    const h = await createHarness({
      script: [[fakeDelay(1_000_000)]],
      mind: { turn: { maxSteps: 8, stallMs: 5_000 } },
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    jest.useFakeTimers()
    await say(h, thread.id, 'hi')
    await advance(h.clock, 4_999)
    expect(framesOfType(h, LAPTOP, 'error')).toHaveLength(0)
    await advance(h.clock, 1)
    await flushMicrotasks()
    expect(framesOfType(h, LAPTOP, 'error')[0]?.data.code).toBe('PROVIDER_ERROR')
    expect(h.tm.state(thread.id)).toBe('idle')
  })
})

describe('hardening (P3-H1)', () => {
  test('B2: no delivery flush while the thread is listening; it runs once speech stops', async () => {
    const h = await createHarness({ script: [fakeText('By the way: done.')] })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    h.tm.voiceActivity({ threadId: thread.id, nodeId: LAPTOP, speaking: true })
    expect(h.tm.state(thread.id)).toBe('listening')
    await h.deliveries.enqueue({ personId: TONY, kind: 'task_result', content: 'done' })
    await h.settle()
    expect(h.llm.calls).toBe(0)
    expect(h.tm.state(thread.id)).toBe('listening')
    h.tm.voiceActivity({ threadId: thread.id, nodeId: LAPTOP, speaking: false })
    await h.settle()
    expect(h.bus.named('turn.started')).toMatchObject([{ kind: 'delivery' }])
  })

  test('B2: no briefing while the thread is listening; it runs once speech stops', async () => {
    const h = await createHarness({
      script: [fakeText('Welcome back, sir.')],
      mind: { arrival: { awayAfterMinutes: 30, briefing: 'auto', holdMs: 120_000, graceMs: 1_500 } },
    })
    await tonyAway(h)
    jest.useFakeTimers()
    const { thread } = await h.open(TONY, LAPTOP, { awayMs: 5_000_000 })
    h.tm.voiceActivity({ threadId: thread.id, nodeId: LAPTOP, speaking: true })
    await advance(h.clock, 2_000)
    expect(h.llm.calls).toBe(0)
    h.tm.voiceActivity({ threadId: thread.id, nodeId: LAPTOP, speaking: false })
    await advance(h.clock, 10)
    expect(h.bus.named('turn.started')).toMatchObject([{ kind: 'briefing' }])
  })

  test('B3: a failed critical delivery turn does not pre-empt queued input again', async () => {
    const gate = createGate()
    const h = await createHarness({
      llmSleep: gate.sleep,
      script: [
        [...fakeText('Hm'), fakeDelay(1)],
        () => {
          throw new ProviderError('auth', 'bad key')
        },
        fakeText('Answer'),
      ],
      fallback: fakeText('ALERT again'),
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    await say(h, thread.id, 'first')
    await flushMicrotasks()
    await say(h, thread.id, 'second')
    await h.deliveries.enqueue({ personId: TONY, kind: 'plugin', urgency: 'critical', content: 'Breach' })
    await h.bus.idle()
    gate.release()
    await h.settle()
    expect(
      h.bus
        .named('turn.started')
        .map((t) => t.kind)
        .slice(0, 3),
    ).toEqual(['user', 'delivery', 'user'])
    expect(h.llm.requests[2]?.messages.at(-1)).toEqual({ role: 'user', content: 'second' })
    const replies = framesOfType(h, LAPTOP, 'message.completed').map((f) => f.data.message.content)
    expect(replies).toContain('Answer')
  })

  test('B4: a turn without focus uses the most recently attached node', async () => {
    const h = await createHarness({ script: [fakeText('By the way: done.')] })
    const { thread } = await h.open(TONY, LAPTOP)
    await h.open(TONY, PEPPER_PHONE)
    await h.open(TONY, PHONE)
    await h.settle()
    h.sink.detach(LAPTOP)
    h.tm.detach({ nodeId: LAPTOP })
    await h.deliveries.enqueue({ personId: TONY, threadId: thread.id, kind: 'task_result', content: 'done' })
    await h.settle()
    expect(h.llm.calls).toBe(1)
    // Only PHONE (the newer of the two still attached) declared ui.render@1.
    expect(h.llm.requests[0]?.system).toContain('ui.render@1')
  })

  test('B5: open honors historyLimit (default 50, max 200) and counts visible messages only', async () => {
    const h = await createHarness()
    const { thread } = await h.open(TONY, LAPTOP)
    await h.settle()
    let t = h.clock.now()
    const base = { threadId: thread.id, modality: 'text' as const, meta: null }
    for (let i = 0; i < 130; i++) {
      await h.repos.messages.append({
        ...base,
        id: h.ids.next('msg'),
        role: 'user',
        authorPersonId: TONY,
        nodeId: LAPTOP,
        content: `u${i}`,
        createdAt: ++t,
      })
      // A hidden tool step between each input and its reply.
      await h.repos.messages.append({
        ...base,
        id: h.ids.next('msg'),
        role: 'assistant',
        authorPersonId: null,
        nodeId: null,
        content: '',
        createdAt: ++t,
        toolCalls: [{ id: `c${i}`, name: 'test.echo', args: {} }],
        ui: null,
      })
      await h.repos.messages.append({
        ...base,
        id: h.ids.next('msg'),
        role: 'tool',
        authorPersonId: null,
        nodeId: null,
        content: 'x',
        createdAt: ++t,
        toolCallId: `c${i}`,
        toolName: 'test.echo',
        isError: false,
      })
      await h.repos.messages.append({
        ...base,
        id: h.ids.next('msg'),
        role: 'assistant',
        authorPersonId: null,
        nodeId: null,
        content: `a${i}`,
        createdAt: ++t,
        toolCalls: null,
        ui: null,
      })
    }
    const open = (historyLimit?: number) =>
      h.tm.open({ personId: TONY, nodeId: LAPTOP, threadId: thread.id, arrival: null, historyLimit })
    const byDefault = await open()
    expect(byDefault.messages).toHaveLength(50)
    expect(byDefault.messages.at(-1)?.content).toBe('a129')
    const many = await open(120)
    expect(many.messages).toHaveLength(120)
    expect(many.messages[0]?.content).toBe('u70')
    expect(many.messages.at(-1)?.content).toBe('a129')
    expect((await open(500)).messages).toHaveLength(200)
    expect((await open(3)).messages.map((m) => m.content)).toEqual(['a128', 'u129', 'a129'])
    expect((await open(0)).messages).toEqual([])
    await h.settle()
  })

  test('B6: cancelAll aborts every running turn and resolves once they are persisted', async () => {
    const gate = createGate()
    const turn = [...fakeText('Part'), fakeDelay(1), ...fakeText(' rest')]
    const h = await createHarness({ llmSleep: gate.sleep, fallback: turn })
    const tony = await h.open(TONY, LAPTOP)
    const pepper = await h.open(PEPPER, PEPPER_PHONE)
    await h.settle()
    await say(h, tony.thread.id, 'story', LAPTOP, TONY)
    await say(h, pepper.thread.id, 'story', PEPPER_PHONE, PEPPER)
    await flushMicrotasks()
    expect(gate.waiting).toBe(2)
    await h.tm.cancelAll()
    const replies = h.repos.all.messages.filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(2)
    for (const r of replies) expect(r).toMatchObject({ content: 'Part', meta: { cancelled: true } })
    expect(h.tm.state(tony.thread.id)).toBe('idle')
    expect(h.tm.state(pepper.thread.id)).toBe('idle')
    await h.tm.cancelAll()
    await h.settle()
  })

  test('C2: a turn failing on a provider rate_limited sends RATE_LIMITED', async () => {
    const h = await createHarness({
      script: [
        () => {
          throw new ProviderError('rate_limited', '429', { retryable: false })
        },
      ],
    })
    const { thread } = await h.open(TONY, LAPTOP)
    await say(h, thread.id, 'hi')
    await h.settle()
    const [error] = framesOfType(h, LAPTOP, 'error')
    expect(error?.data.code).toBe('RATE_LIMITED')
    expect(CoreFrameSchema.safeParse(error).success).toBe(true)
    const [completed] = framesOfType(h, LAPTOP, 'message.completed')
    expect(completed?.data.message.content).toBe(APOLOGY_TEXT)
    expect(h.bus.named('turn.failed')).toMatchObject([{ code: 'RATE_LIMITED' }])
  })
})
