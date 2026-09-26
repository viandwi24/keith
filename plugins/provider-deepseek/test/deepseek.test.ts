import { describe, expect, test } from 'bun:test'
import { isKeithError, isProviderError, type LlmEvent, type LlmRequest, type ProviderError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createDeepSeekLlm, DEEPSEEK_BASE_URL, deepSeekThinking } from '../src/index.ts'
import { replay } from './replay.ts'

const req: LlmRequest = {
  model: 'example-model',
  system: 'You are Keith.',
  messages: [{ role: 'user', content: 'Hello' }],
}

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

const text = (events: LlmEvent[], type: 'text.delta' | 'reasoning.delta' = 'text.delta') =>
  events.map((e) => (e.type === type ? e.text : '')).join('')

function provider(fixture: string) {
  const r = replay(fixture)
  return { r, llm: createDeepSeekLlm({ apiKey: 'sk-ds-test', fetch: r.fetch }) }
}

const tool = { name: 'weather.current', description: 'Current weather.', inputSchema: { type: 'object' } }

describe('@keith/provider-deepseek plugin', () => {
  test('registers exactly one LLM provider with id deepseek', async () => {
    const ctx = await setupFakePlugin(plugin, { config: { apiKey: 'sk-ds-test' } })
    expect(ctx.recorded.llm).toHaveLength(1)
    expect(ctx.recorded.llm[0]?.id).toBe('deepseek')
  })

  test('rejects config without an apiKey', async () => {
    const error = await errorOf(setupFakePlugin(plugin, { config: { baseUrl: DEEPSEEK_BASE_URL } }))
    expect(isKeithError(error, 'CONFIG_INVALID')).toBe(true)
  })
})

describe('DeepSeek thinking mapping', () => {
  test('maps LlmRequest.reasoning to thinking and reasoning_effort', () => {
    expect(deepSeekThinking(req)).toEqual({})
    expect(deepSeekThinking({ ...req, reasoning: 'off' })).toEqual({ thinking: { type: 'disabled' } })
    expect(deepSeekThinking({ ...req, reasoning: 'low' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    })
    for (const reasoning of ['medium', 'high'] as const) {
      expect(deepSeekThinking({ ...req, reasoning })).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      })
    }
  })

  test('disables thinking when the request carries tools', () => {
    expect(deepSeekThinking({ ...req, reasoning: 'high', tools: [tool] })).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(deepSeekThinking({ ...req, tools: [tool] })).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('DeepSeek provider (synthetic fixtures)', () => {
  test('text: deltas concatenate, finish comes last exactly once with usage', async () => {
    const { r, llm } = provider('text.sse')
    const events = await collect(llm.stream(req, new AbortController().signal))
    expect(text(events)).toBe('Hello! How can I assist you today?')
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 17, outputTokens: 9, cachedInputTokens: 0 },
    })
    expect(r.requests[0]?.url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`)
    const headers = r.requests[0]?.init.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe('Bearer sk-ds-test')
  })

  test('a tool call split across chunks is emitted once with parsed args', async () => {
    const { r, llm } = provider('tool-call-split.sse')
    const events = await collect(llm.stream({ ...req, tools: [tool] }, new AbortController().signal))
    expect(events).toEqual([
      {
        type: 'tool.call',
        call: {
          id: 'call_fixture_1',
          name: 'weather.current',
          args: { location: 'Hangzhou', date: '2026-09-26' },
        },
      },
      {
        type: 'finish',
        reason: 'tool_calls',
        usage: { inputTokens: 120, outputTokens: 25, cachedInputTokens: 64 },
      },
    ])
    const body = r.requests[0]?.body
    expect(body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather__current',
          description: 'Current weather.',
          parameters: { type: 'object' },
        },
      },
    ])
    expect(body?.thinking).toEqual({ type: 'disabled' })
  })

  test('parallel tool calls are each emitted once, in order', async () => {
    const { llm } = provider('parallel-tool-calls.sse')
    const events = await collect(llm.stream(req, new AbortController().signal))
    expect(events.filter((e) => e.type === 'tool.call')).toEqual([
      { type: 'tool.call', call: { id: 'call_fixture_1', name: 'clock.today', args: {} } },
      {
        type: 'tool.call',
        call: {
          id: 'call_fixture_2',
          name: 'weather.current',
          args: { location: 'Paris', date: '2026-09-26' },
        },
      },
    ])
    expect(events.at(-1)?.type).toBe('finish')
  })

  test('thinking mode streams reasoning_content as reasoning.delta', async () => {
    const { r, llm } = provider('reasoning.sse')
    const events = await collect(llm.stream({ ...req, reasoning: 'medium' }, new AbortController().signal))
    expect(text(events, 'reasoning.delta')).toBe('Compare 9.11 and 9.8 by the tenths digit.')
    expect(text(events)).toBe('9.8 is greater.')
    const firstText = events.findIndex((e) => e.type === 'text.delta')
    expect(events.slice(firstText).some((e) => e.type === 'reasoning.delta')).toBe(false)
    expect(r.requests[0]?.body?.thinking).toEqual({ type: 'enabled' })
    expect(r.requests[0]?.body?.reasoning_effort).toBe('high')
  })

  test('401 → ProviderError(auth), not retryable', async () => {
    const { llm } = provider('error-401.json')
    const error = await errorOf(collect(llm.stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'auth')).toBe(true)
    expect((error as ProviderError).retryable).toBe(false)
    expect((error as ProviderError).status).toBe(401)
  })

  test('429 → ProviderError(rate_limited), retryable', async () => {
    const { llm } = provider('error-429.json')
    const error = await errorOf(collect(llm.stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'rate_limited')).toBe(true)
    expect((error as ProviderError).retryable).toBe(true)
    expect((error as ProviderError).status).toBe(429)
  })

  test('abort mid-stream ends with ProviderError(aborted) and aborts the fetch', async () => {
    const { r, llm } = provider('text.sse')
    const controller = new AbortController()
    let seen = 0
    const error = await errorOf(
      (async () => {
        for await (const e of llm.stream(req, controller.signal)) {
          if (e.type === 'text.delta') {
            seen++
            controller.abort()
          }
        }
      })(),
    )
    expect(seen).toBe(1)
    expect(isProviderError(error, 'aborted')).toBe(true)
    expect(r.requests[0]?.init.signal?.aborted).toBe(true)
    expect(r.cancelled).toBe(true)
  })

  test('listModels reads the models endpoint', async () => {
    const { r, llm } = provider('models.json')
    const models = await llm.listModels?.()
    expect(r.requests[0]?.url).toBe(`${DEEPSEEK_BASE_URL}/models`)
    expect(models).toEqual([
      { id: 'example-flash', contextWindow: 1048576 },
      { id: 'example-pro', contextWindow: 1048576 },
    ])
  })
})
