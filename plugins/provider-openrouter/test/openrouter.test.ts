import { describe, expect, test } from 'bun:test'
import { isKeithError, isProviderError, type LlmEvent, type LlmRequest, type ProviderError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createOpenRouterLlm, OPENROUTER_BASE_URL } from '../src/index.ts'
import { replay } from './replay.ts'

const req: LlmRequest = {
  model: 'example/model',
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

function provider(fixture: string, extra: { appTitle?: string; siteUrl?: string } = {}) {
  const r = replay(fixture)
  return { r, llm: createOpenRouterLlm({ apiKey: 'sk-or-test', fetch: r.fetch, ...extra }) }
}

describe('@keith/provider-openrouter plugin', () => {
  test('registers exactly one LLM provider with id openrouter', async () => {
    const ctx = await setupFakePlugin(plugin, { config: { apiKey: 'sk-or-test' } })
    expect(ctx.recorded.llm).toHaveLength(1)
    expect(ctx.recorded.llm[0]?.id).toBe('openrouter')
    expect(typeof ctx.recorded.llm[0]?.listModels).toBe('function')
  })

  test('rejects config without an apiKey', async () => {
    const error = await errorOf(setupFakePlugin(plugin, { config: {} }))
    expect(isKeithError(error, 'CONFIG_INVALID')).toBe(true)
  })
})

describe('OpenRouter provider (synthetic fixtures)', () => {
  test('text: deltas concatenate, finish comes last exactly once, keep-alive comments are ignored', async () => {
    const { r, llm } = provider('text.sse')
    const events = await collect(llm.stream(req, new AbortController().signal))
    expect(text(events)).toBe('Hello! How can I help today?')
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 21, outputTokens: 8, cachedInputTokens: 4 },
    })
    expect(r.requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
  })

  test('sends attribution headers and the bearer key', async () => {
    const { r, llm } = provider('text.sse', { appTitle: 'Keith', siteUrl: 'https://keith.example' })
    await collect(llm.stream(req, new AbortController().signal))
    const headers = r.requests[0]?.init.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://keith.example')
    expect(headers['X-OpenRouter-Title']).toBe('Keith')
    expect(headers.authorization).toBe('Bearer sk-or-test')
  })

  test('a tool call split across chunks is emitted once with parsed args', async () => {
    const { llm } = provider('tool-call-split.sse')
    const events = await collect(llm.stream(req, new AbortController().signal))
    expect(events).toEqual([
      {
        type: 'tool.call',
        call: { id: 'call_fixture_1', name: 'web.search', args: { query: 'Joyce novels', limit: 3 } },
      },
      {
        type: 'finish',
        reason: 'tool_calls',
        usage: { inputTokens: 64, outputTokens: 22, cachedInputTokens: 0 },
      },
    ])
  })

  test('parallel tool calls are each emitted once, in order', async () => {
    const { llm } = provider('parallel-tool-calls.sse')
    const events = await collect(llm.stream(req, new AbortController().signal))
    expect(events.filter((e) => e.type === 'tool.call')).toEqual([
      { type: 'tool.call', call: { id: 'call_fixture_1', name: 'weather.current', args: { city: 'Paris' } } },
      { type: 'tool.call', call: { id: 'call_fixture_2', name: 'weather.current', args: { city: 'Rome' } } },
    ])
    expect(events.at(-1)?.type).toBe('finish')
  })

  test('reasoning streams as reasoning.delta, once (reasoning_details are not duplicated)', async () => {
    const { r, llm } = provider('reasoning.sse')
    const events = await collect(llm.stream({ ...req, reasoning: 'high' }, new AbortController().signal))
    expect(text(events, 'reasoning.delta')).toBe('9.11 vs 9.8: compare the tenths digit.')
    expect(text(events)).toBe('9.8 is greater.')
    expect(r.requests[0]?.body?.reasoning).toEqual({ effort: 'high' })
  })

  test('reasoning off maps to effort none; unset sends no reasoning field', async () => {
    const off = provider('text.sse')
    await collect(off.llm.stream({ ...req, reasoning: 'off' }, new AbortController().signal))
    expect(off.r.requests[0]?.body?.reasoning).toEqual({ effort: 'none' })
    const unset = provider('text.sse')
    await collect(unset.llm.stream(req, new AbortController().signal))
    expect(unset.r.requests[0]?.body).not.toHaveProperty('reasoning')
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
  })

  test('a mid-stream error event throws after the partial text, without a finish', async () => {
    const { llm } = provider('mid-stream-error.sse')
    const seen: LlmEvent[] = []
    const error = await errorOf(
      (async () => {
        for await (const e of llm.stream(req, new AbortController().signal)) seen.push(e)
      })(),
    )
    expect(text(seen)).toBe('Partial')
    expect(seen.some((e) => e.type === 'finish')).toBe(false)
    expect(isProviderError(error, 'rate_limited')).toBe(true)
  })

  test('abort mid-stream ends with ProviderError(aborted) and aborts the fetch', async () => {
    const { r, llm } = provider('text.sse')
    const controller = new AbortController()
    const seen: LlmEvent[] = []
    const error = await errorOf(
      (async () => {
        for await (const e of llm.stream(req, controller.signal)) {
          seen.push(e)
          controller.abort()
        }
      })(),
    )
    expect(seen).toHaveLength(1)
    expect(isProviderError(error, 'aborted')).toBe(true)
    expect(r.requests[0]?.init.signal?.aborted).toBe(true)
    expect(r.cancelled).toBe(true)
  })

  test('listModels reads the models endpoint', async () => {
    const { r, llm } = provider('models.json')
    const models = await llm.listModels?.(new AbortController().signal)
    expect(r.requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/models`)
    expect(models).toEqual([
      { id: 'example/tool-model', contextWindow: 128000, supportsTools: true },
      { id: 'example/plain-model', contextWindow: 8192, supportsTools: false },
    ])
  })
})
