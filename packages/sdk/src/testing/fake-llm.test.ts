import { describe, expect, test } from 'bun:test'
import { isKeithError } from '../errors.ts'
import { isProviderError, type LlmEvent, type LlmRequest, ProviderError } from '../providers/types.ts'
import { setupFakePlugin } from './fake-context.ts'
import { createFakeLlm, createFakeLlmPlugin, fakeDelay, fakeText, fakeToolCall } from './fake-llm.ts'

const req = (text = 'hi'): LlmRequest => ({
  model: 'fake-model',
  system: 'You are Keith.',
  messages: [{ role: 'user', content: text }],
})

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

/** The rejection reason of a promise, or null when it resolves. */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

const text = (events: LlmEvent[]) => events.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')

describe('createFakeLlm', () => {
  test('streams text deltas and ends with exactly one finish', async () => {
    const llm = createFakeLlm([fakeText('The shortlist is ready.', 5)])
    const events = await collect(llm.stream(req(), new AbortController().signal))
    expect(text(events)).toBe('The shortlist is ready.')
    expect(events.filter((e) => e.type === 'text.delta')).toHaveLength(5)
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  })

  test('emits tool calls and finishes with reason tool_calls', async () => {
    const llm = createFakeLlm([
      [fakeToolCall('task.start', { goal: 'research venues', notify: 'when-done' })],
    ])
    const events = await collect(llm.stream(req(), new AbortController().signal))
    expect(events).toEqual([
      {
        type: 'tool.call',
        call: {
          id: 'call_task_start',
          name: 'task.start',
          args: { goal: 'research venues', notify: 'when-done' },
        },
      },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  test('keeps an explicit finish event with usage', async () => {
    const finish: LlmEvent = { type: 'finish', reason: 'length', usage: { inputTokens: 10, outputTokens: 2 } }
    const llm = createFakeLlm([[...fakeText('ab'), finish]])
    expect((await collect(llm.stream(req(), new AbortController().signal))).at(-1)).toEqual(finish)
  })

  test('rejects scripts with a misplaced or repeated finish', async () => {
    const stop: LlmEvent = { type: 'finish', reason: 'stop' }
    const misplaced = createFakeLlm([[stop, ...fakeText('late')]])
    const repeated = createFakeLlm([[stop, stop]])
    const signal = new AbortController().signal
    expect(isKeithError(await errorOf(collect(misplaced.stream(req(), signal))), 'INTERNAL')).toBe(true)
    expect(isKeithError(await errorOf(collect(repeated.stream(req(), signal))), 'INTERNAL')).toBe(true)
  })

  test('plays turns in order and records every request', async () => {
    const llm = createFakeLlm([fakeText('one'), fakeText('two')])
    const signal = new AbortController().signal
    expect(text(await collect(llm.stream(req('first'), signal)))).toBe('one')
    expect(text(await collect(llm.stream(req('second'), signal)))).toBe('two')
    expect(llm.calls).toBe(2)
    expect(llm.requests.map((r) => r.messages[0]?.content)).toEqual(['first', 'second'])
  })

  test('recorded requests are copies, not live references', async () => {
    const llm = createFakeLlm([fakeText('ok')])
    const request = req('before')
    await collect(llm.stream(request, new AbortController().signal))
    request.messages.push({ role: 'user', content: 'after' })
    expect(llm.requests[0]?.messages).toHaveLength(1)
  })

  test('a turn can be a function of the request', async () => {
    const llm = createFakeLlm([(r, call) => fakeText(`echo ${call}: ${r.messages.at(-1)?.content}`)])
    expect(text(await collect(llm.stream(req('ping'), new AbortController().signal)))).toBe('echo 0: ping')
  })

  test('an exhausted script throws, unless a fallback is set', async () => {
    const strict = createFakeLlm([])
    expect(
      isProviderError(await errorOf(collect(strict.stream(req(), new AbortController().signal))), 'unknown'),
    ).toBe(true)
    const lenient = createFakeLlm([], { fallback: fakeText('default') })
    expect(text(await collect(lenient.stream(req(), new AbortController().signal)))).toBe('default')
    expect(text(await collect(lenient.stream(req(), new AbortController().signal)))).toBe('default')
  })

  test('push appends turns', async () => {
    const llm = createFakeLlm()
    llm.push(fakeText('later'))
    expect(text(await collect(llm.stream(req(), new AbortController().signal)))).toBe('later')
  })

  test('delays pause the stream', async () => {
    const llm = createFakeLlm([[...fakeText('a'), fakeDelay(30), ...fakeText('b')]])
    const started = performance.now()
    expect(text(await collect(llm.stream(req(), new AbortController().signal)))).toBe('ab')
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
  })

  test('S-4 groundwork: two delayed streams run concurrently', async () => {
    const llm = createFakeLlm([
      [fakeDelay(60), ...fakeText('tony')],
      [fakeDelay(60), ...fakeText('pepper')],
    ])
    const started = performance.now()
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([collect(llm.stream(req(), signal)), collect(llm.stream(req(), signal))])
    expect(text(a) + text(b)).toBe('tonypepper')
    expect(performance.now() - started).toBeLessThan(110)
  })

  test("aborting mid-stream throws ProviderError('aborted')", async () => {
    const llm = createFakeLlm([[...fakeText('partial'), fakeDelay(1_000), ...fakeText(' never')]])
    const controller = new AbortController()
    const seen: LlmEvent[] = []
    const run = (async () => {
      for await (const e of llm.stream(req(), controller.signal)) {
        seen.push(e)
        if (e.type === 'text.delta') controller.abort()
      }
    })()
    const error = await run.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe('aborted')
    expect((error as ProviderError).retryable).toBe(false)
    expect(text(seen)).toBe('partial')
  })

  test('aborting during a delay ends the stream promptly', async () => {
    const llm = createFakeLlm([[fakeDelay(5_000), ...fakeText('never')]])
    const controller = new AbortController()
    const started = performance.now()
    setTimeout(() => controller.abort(), 20)
    expect(isProviderError(await errorOf(collect(llm.stream(req(), controller.signal))), 'aborted')).toBe(
      true,
    )
    await Bun.sleep(40)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('an already aborted signal fails before any event, and the request is still recorded', async () => {
    const llm = createFakeLlm([fakeText('x')])
    const controller = new AbortController()
    controller.abort()
    const events: LlmEvent[] = []
    const error = await (async () => {
      for await (const e of llm.stream(req(), controller.signal)) events.push(e)
    })().then(
      () => null,
      (e: unknown) => e,
    )
    expect(isProviderError(error, 'aborted')).toBe(true)
    expect(events).toEqual([])
    expect(llm.requests).toHaveLength(1)
  })

  test('the id defaults to fake and can be set', () => {
    expect(createFakeLlm().id).toBe('fake')
    expect(createFakeLlm([], { id: 'deepseek' }).id).toBe('deepseek')
  })
})

test('createFakeLlmPlugin registers the fake as an LLM provider', async () => {
  const fake = createFakeLlm([fakeText('hi')])
  const ctx = await setupFakePlugin(createFakeLlmPlugin(fake))
  expect(ctx.plugin.kind).toBe('provider')
  expect(ctx.recorded.llm).toEqual([fake])
})
