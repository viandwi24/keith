import { afterEach, describe, expect, jest, test } from 'bun:test'
import { defineTool, isKeithError, ProviderError, type Tool } from '@keith/sdk'
import {
  createFakeClock,
  createFakeLlm,
  createMemoryLogger,
  type FakeLlmTurn,
  fakeDelay,
  fakeText,
  fakeToolCall,
} from '@keith/sdk/testing'
import { z } from 'zod'
import { createServiceRegistry } from '../plugins/services.ts'
import { createToolRegistry } from '../plugins/tools.ts'
import type { ThreadId } from '../shared/types.ts'
import { createRunLoop } from './run-loop.ts'
import {
  createFakeBus,
  createFakeIds,
  createFakeProviders,
  createFakeRepos,
  createFakeToolRegistry,
} from './testing/fakes.ts'
import { advance, flushMicrotasks, TONY } from './testing/harness.ts'
import type { RunLoopArgs, RunLoopEvent } from './types.ts'

afterEach(() => {
  jest.useRealTimers()
})

const THREAD = 'thr_00000000000000000000000001' as ThreadId

const echo = defineTool({
  name: 'test.echo',
  description: 'Echo the text back',
  input: z.object({ text: z.string() }),
  minTier: 'guest',
  run: async ({ text }) => ({ content: `echo: ${text}` }),
})

async function setup(
  script: FakeLlmTurn[],
  tools: Tool[] = [echo],
  extra: { stallMs?: number; invokeThrows?: boolean } = {},
) {
  const clock = createFakeClock(1_000)
  const repos = createFakeRepos()
  await repos.persons.create({
    id: TONY,
    name: 'Tony',
    username: 'tony',
    passwordHash: null,
    tier: 'owner',
    lastSeenAt: null,
    createdAt: 0,
  })
  const llm = createFakeLlm(script)
  const bus = createFakeBus(clock)
  const registry = createFakeToolRegistry(tools, bus)
  const log = createMemoryLogger()
  const runLoop = createRunLoop({
    providers: createFakeProviders(llm),
    tools: extra.invokeThrows
      ? {
          get: registry.get,
          invoke: async () => {
            throw new Error('registry bug')
          },
        }
      : registry,
    repos,
    events: bus,
    ids: createFakeIds(),
    clock,
    log,
    stallMs: extra.stallMs ?? 120_000,
    retryBaseMs: 10,
  })
  const events: RunLoopEvent[] = []
  const args = (over: Partial<RunLoopArgs> = {}): RunLoopArgs => ({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: tools.map((t) => t.name),
    modelRole: 'foreground',
    maxSteps: 8,
    runCtx: { personId: TONY, participants: [TONY], threadId: THREAD, taskId: null },
    persist: { threadId: THREAD },
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...over,
  })
  return { clock, repos, llm, bus, log, runLoop, events, args }
}

describe('run loop', () => {
  test('returns the text of a plain completion', async () => {
    const s = await setup([fakeText('Hello', 2)])
    const result = await s.runLoop(s.args())
    expect(result).toEqual({ text: 'Hello', steps: 1, stoppedBy: 'stop' })
    expect(
      s.events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.text : '')),
    ).toEqual(['He', 'll', 'o'])
    expect(s.llm.requests[0]?.tools).toEqual([
      {
        name: 'test.echo',
        description: 'Echo the text back',
        inputSchema: expect.objectContaining({ type: 'object' }),
      },
    ])
  })

  test('runs tool calls, feeds results back, and persists the step when persist is set', async () => {
    const s = await setup([[fakeToolCall('test.echo', { text: 'x' }, 'call_1')], fakeText('Done')])
    const result = await s.runLoop(s.args())
    expect(result).toEqual({ text: 'Done', steps: 2, stoppedBy: 'stop' })
    expect(s.llm.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'echo: x',
    })
    expect(s.repos.all.messages).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'test.echo' }], content: '' },
      { role: 'tool', toolCallId: 'call_1', toolName: 'test.echo', isError: false, content: 'echo: x' },
    ])
    expect(s.bus.named('tool.called')).toMatchObject([{ toolCallId: 'call_1', threadId: THREAD }])
    expect(s.bus.named('tool.completed')).toMatchObject([{ toolCallId: 'call_1', ok: true }])
    expect(s.bus.named('thread.message_added').map((e) => e.role)).toEqual(['assistant', 'tool'])
    expect(s.events.map((e) => e.type)).toEqual([
      'tool.started',
      'tool.completed',
      'step.completed',
      'text.delta',
      'step.completed',
    ])
  })

  test('T3 / B1: through the real registry, each tool call emits exactly one tool.called / tool.completed', async () => {
    const clock = createFakeClock(1_000)
    const log = createMemoryLogger()
    const bus = createFakeBus(clock)
    const repos = createFakeRepos()
    await repos.persons.create({
      id: TONY,
      name: 'Tony',
      username: 'tony',
      passwordHash: null,
      tier: 'owner',
      lastSeenAt: null,
      createdAt: 0,
    })
    const services = createServiceRegistry({ winners: {}, log })
    const tools = createToolRegistry({ log, clock, services, events: bus })
    tools.registerBuiltin(defineTool({ ...echo, name: 'memory.echo' }))
    const llm = createFakeLlm([
      [fakeToolCall('memory.echo', { text: 'x' }, 'c1'), fakeToolCall('memory.missing', {}, 'c2')],
      fakeText('Done'),
    ])
    const runLoop = createRunLoop({
      providers: createFakeProviders(llm),
      tools,
      repos,
      events: bus,
      ids: createFakeIds(),
      clock,
      log,
      stallMs: 120_000,
    })
    await runLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['memory.echo'],
      modelRole: 'foreground',
      maxSteps: 8,
      runCtx: { personId: TONY, participants: [TONY], threadId: THREAD, taskId: null },
      persist: { threadId: THREAD },
      signal: new AbortController().signal,
    })
    await bus.idle()
    expect(bus.named('tool.called').map((e) => e.toolCallId)).toEqual(['c1', 'c2'])
    // Calls run in parallel, so completions may come in any order.
    const completed = bus.named('tool.completed').map((e) => [e.toolCallId, e.ok])
    expect(completed.sort()).toEqual([
      ['c1', true],
      ['c2', false],
    ])
  })

  test('does not persist tool messages when persist is null (tasks)', async () => {
    const s = await setup([[fakeToolCall('test.echo', { text: 'x' })], fakeText('Done')])
    await s.runLoop(
      s.args({
        persist: null,
        runCtx: {
          personId: TONY,
          participants: [TONY],
          threadId: null,
          taskId: 'tsk_00000000000000000000000001',
        },
      }),
    )
    expect(s.repos.all.messages).toHaveLength(0)
  })

  test('tool errors, unknown tools and invalid input become tool results', async () => {
    const s = await setup([
      [fakeToolCall('test.missing', {}, 'a'), fakeToolCall('test.echo', { text: 1 }, 'b')],
      fakeText('Recovered'),
    ])
    const result = await s.runLoop(s.args())
    expect(result.text).toBe('Recovered')
    const toolMessages = s.llm.requests[1]?.messages.filter((m) => m.role === 'tool') ?? []
    expect(toolMessages).toHaveLength(2)
    expect(
      s.repos.all.messages.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.isError),
    ).toEqual([true, true])
    expect(
      s.events.filter((e) => e.type === 'tool.completed').map((e) => e.type === 'tool.completed' && e.ok),
    ).toEqual([false, false])
  })

  test('a registry that throws still yields a tool result, not a crash', async () => {
    const s = await setup([[fakeToolCall('test.echo', { text: 'x' })], fakeText('ok')], [echo], {
      invokeThrows: true,
    })
    const result = await s.runLoop(s.args())
    expect(result.text).toBe('ok')
    expect(s.llm.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('registry bug'),
    })
  })

  test('forwards ui blocks with a fallback text', async () => {
    const card = defineTool({
      name: 'test.card',
      description: 'card',
      input: z.object({}),
      minTier: 'guest',
      run: async () => ({ content: 'shown', ui: { type: 'markdown', id: 'b1', text: 'Hi there' } }),
    })
    const s = await setup([[fakeToolCall('test.card', {}, 'u1')], fakeText('ok')], [card])
    await s.runLoop(s.args())
    const ui = s.events.find((e) => e.type === 'ui')
    expect(ui).toMatchObject({
      type: 'ui',
      toolCallId: 'u1',
      toolName: 'test.card',
      fallbackText: expect.any(String),
    })
  })

  test('stops at the step limit', async () => {
    const s = await setup([], [echo])
    s.llm.push(...Array.from({ length: 3 }, () => [fakeToolCall('test.echo', { text: 'again' })]))
    const result = await s.runLoop(s.args({ maxSteps: 3 }))
    expect(result).toMatchObject({ steps: 3, stoppedBy: 'step_limit' })
  })

  test('retries a retryable provider error twice, then succeeds', async () => {
    let failures = 0
    const failing = () => {
      failures++
      throw new ProviderError('unavailable', '503')
    }
    const s = await setup([failing, failing, fakeText('third time')])
    jest.useFakeTimers()
    const done = s.runLoop(s.args())
    await advance(s.clock, 100, 5)
    expect(await done).toMatchObject({ text: 'third time', stoppedBy: 'stop' })
    expect(failures).toBe(2)
  })

  test('C2: gives up after two retries; a provider rate_limited becomes RATE_LIMITED', async () => {
    const failing = () => {
      throw new ProviderError('rate_limited', '429')
    }
    const s = await setup([failing, failing, failing, fakeText('never')])
    jest.useFakeTimers()
    const done = s.runLoop(s.args()).then(
      () => null,
      (e: unknown) => e,
    )
    await advance(s.clock, 100, 5)
    const error = await done
    expect(isKeithError(error, 'RATE_LIMITED')).toBe(true)
    expect(s.llm.calls).toBe(3)
  })

  test('does not retry a non-retryable error', async () => {
    const s = await setup([
      () => {
        throw new ProviderError('bad_request', '400')
      },
    ])
    let caught: unknown
    try {
      await s.runLoop(s.args())
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught, 'PROVIDER_ERROR')).toBe(true)
    expect(s.llm.calls).toBe(1)
  })

  test('the stall watchdog aborts a silent step', async () => {
    const s = await setup([[...fakeText('so'), fakeDelay(60_000), ...fakeText('mething')]], [echo], {
      stallMs: 1_000,
    })
    jest.useFakeTimers()
    const done = s.runLoop(s.args()).then(
      () => null,
      (e: unknown) => e,
    )
    await advance(s.clock, 999)
    let settled = false
    void done.then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(settled).toBe(false)
    await advance(s.clock, 1)
    const error = await done
    expect(isKeithError(error, 'PROVIDER_ERROR')).toBe(true)
    expect(s.llm.calls).toBe(1)
    expect(s.log.entries.some((e) => e.msg === 'llm step stalled')).toBe(true)
  })

  test('cancellation returns the partial text', async () => {
    const controller = new AbortController()
    const s = await setup([[...fakeText('Part'), fakeDelay(10_000), ...fakeText('ial')]])
    jest.useFakeTimers()
    const done = s.runLoop(s.args({ signal: controller.signal }))
    await flushMicrotasks()
    controller.abort()
    await flushMicrotasks()
    expect(await done).toEqual({ text: 'Part', steps: 1, stoppedBy: 'cancelled' })
  })
})
