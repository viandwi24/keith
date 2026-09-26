import { describe, expect, test } from 'bun:test'
import { isProviderError, type LlmEvent, type LlmRequest, ProviderError } from '../types.ts'
import { createOpenAICompatibleLlm, type OpenAICompatibleLlmOptions } from './provider.ts'

// Synthetic SSE bodies in the OpenAI-compatible chunk shape. Vendor-specific fixtures live in
// each provider plugin's test/fixtures.

type Call = { url: string; init: RequestInit; signal: AbortSignal; body: Record<string, unknown> | undefined }

type Reply = {
  status?: number
  /** Pieces of the body, delivered one read at a time. */
  pieces?: string[]
  json?: unknown
  /** Keep the body open after the last piece until cancelled. */
  hang?: boolean
}

function fakeFetch(reply: Reply | ((call: Call) => Reply | Promise<never>)) {
  const calls: Call[] = []
  let cancelled = false
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      init,
      signal: init.signal as AbortSignal,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    const r = await (typeof reply === 'function' ? reply(call) : reply)
    const status = r.status ?? 200
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json' } })
    }
    const pieces = [...(r.pieces ?? [])]
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = pieces.shift()
        if (next !== undefined) {
          controller.enqueue(encoder.encode(next))
          return
        }
        if (r.hang) return new Promise<void>(() => undefined)
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    fetch: fn as typeof fetch,
    calls,
    get cancelled() {
      return cancelled
    },
  }
}

const sse = (...chunks: unknown[]) =>
  chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`)
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  id: 'gen-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

const req: LlmRequest = {
  model: 'vendor/model',
  system: 'You are Keith.',
  messages: [{ role: 'user', content: 'hi' }],
}

function llm(fetchImpl: typeof fetch, extra: Partial<OpenAICompatibleLlmOptions> = {}) {
  return createOpenAICompatibleLlm({
    id: 'vendor',
    baseUrl: 'https://api.example.test/v1/',
    apiKey: 'sk-test',
    fetch: fetchImpl,
    ...extra,
  })
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

const text = (events: LlmEvent[]) => events.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')
const finishes = (events: LlmEvent[]) => events.filter((e) => e.type === 'finish')

describe('createOpenAICompatibleLlm stream', () => {
  test('streams text deltas, then exactly one finish with usage, last', async () => {
    const f = fakeFetch({
      pieces: [
        ': keep-alive\n\n',
        ...sse(
          delta({ role: 'assistant', content: '' }),
          delta({ content: 'Hel' }),
          delta({ content: 'lo!' }),
        ),
        ...sse(
          {
            ...delta({ content: '' }, 'stop'),
            usage: { prompt_tokens: 17, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
          },
          '[DONE]',
        ),
      ],
    })
    const events = await collect(
      llm(f.fetch, { headers: { 'x-extra': '1' } }).stream(req, new AbortController().signal),
    )
    expect(text(events)).toBe('Hello!')
    expect(finishes(events)).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 17, outputTokens: 3, cachedInputTokens: 5 },
    })
    const call = f.calls[0]
    expect(call?.url).toBe('https://api.example.test/v1/chat/completions')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['x-extra']).toBe('1')
    expect(call?.body?.stream).toBe(true)
  })

  test('assembles a tool call split across chunks and emits it once with parsed args', async () => {
    const f = fakeFetch({
      pieces: sse(
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'web__search', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":"ven' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ues"}' } }] }),
        delta({}, 'tool_calls'),
        // OpenRouter repeats the finish reason on its usage chunk.
        { ...delta({ content: '' }, 'tool_calls'), usage: { prompt_tokens: 4, completion_tokens: 9 } },
        '[DONE]',
      ),
    })
    const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
    expect(events).toEqual([
      { type: 'tool.call', call: { id: 'call_a', name: 'web.search', args: { q: 'venues' } } },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 4, outputTokens: 9 } },
    ])
  })

  test('emits parallel tool calls in index order; bad JSON becomes __raw and empty args {}', async () => {
    const f = fakeFetch({
      pieces: sse(
        delta({
          tool_calls: [
            { index: 0, id: 'c0', function: { name: 'clock__now', arguments: '' } },
            { index: 1, id: 'c1', function: { name: 'web__fetch', arguments: '{"url":' } },
          ],
        }),
        delta({
          tool_calls: [{ index: 2, id: 'c2', function: { name: 'web__search', arguments: '{"q":"x"}' } }],
        }),
        delta({}, 'tool_calls'),
        '[DONE]',
      ),
    })
    const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
    expect(events).toEqual([
      { type: 'tool.call', call: { id: 'c0', name: 'clock.now', args: {} } },
      { type: 'tool.call', call: { id: 'c1', name: 'web.fetch', args: { __raw: '{"url":' } } },
      { type: 'tool.call', call: { id: 'c2', name: 'web.search', args: { q: 'x' } } },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  test('treats a new id at a reused index as a separate call', async () => {
    const f = fakeFetch({
      pieces: sse(
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x__one', arguments: '{}' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'b', function: { name: 'x__two', arguments: '{}' } }] }),
        delta({}, 'tool_calls'),
      ),
    })
    const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
    expect(
      events.filter((e) => e.type === 'tool.call').map((e) => (e.type === 'tool.call' ? e.call.id : '')),
    ).toEqual(['a', 'b'])
  })

  test('maps reasoning_content and reasoning deltas to reasoning.delta', async () => {
    const f = fakeFetch({
      pieces: sse(
        delta({ reasoning_content: 'Think' }),
        delta({ reasoning: 'ing.' }),
        delta({ content: 'Answer' }),
        delta({}, 'stop'),
        '[DONE]',
      ),
    })
    const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
    expect(events).toEqual([
      { type: 'reasoning.delta', text: 'Think' },
      { type: 'reasoning.delta', text: 'ing.' },
      { type: 'text.delta', text: 'Answer' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  test('maps finish reasons length, content_filter and unknown values', async () => {
    for (const [wire, reason] of [
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['insufficient_system_resource', 'other'],
    ] as const) {
      const f = fakeFetch({ pieces: sse(delta({ content: 'x' }, wire), '[DONE]') })
      const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
      expect(events.at(-1)).toEqual({ type: 'finish', reason })
    }
  })

  test('401 → auth (not retryable), 429 → rate_limited (retryable), 503 → unavailable', async () => {
    const cases = [
      [401, 'auth', false],
      [429, 'rate_limited', true],
      [503, 'unavailable', true],
      [400, 'bad_request', false],
    ] as const
    for (const [status, code, retryable] of cases) {
      const f = fakeFetch({ status, json: { error: { code: status, message: `failure ${status}` } } })
      const error = await errorOf(collect(llm(f.fetch).stream(req, new AbortController().signal)))
      expect(isProviderError(error, code)).toBe(true)
      expect((error as ProviderError).retryable).toBe(retryable)
      expect((error as ProviderError).status).toBe(status)
      expect((error as ProviderError).message).toContain(`failure ${status}`)
      expect((error as ProviderError).message).not.toContain('sk-test')
    }
  })

  test('a non-JSON error body still maps by status', async () => {
    const f = fakeFetch({ status: 502, pieces: ['<html>Bad gateway</html>'] })
    const error = await errorOf(collect(llm(f.fetch).stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'unavailable')).toBe(true)
  })

  test('a mid-stream error chunk throws the mapped ProviderError', async () => {
    const f = fakeFetch({
      pieces: sse(delta({ content: 'Par' }), {
        ...delta({ content: '' }, 'error'),
        error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } },
      }),
    })
    const seen: LlmEvent[] = []
    const error = await errorOf(
      (async () => {
        for await (const e of llm(f.fetch).stream(req, new AbortController().signal)) seen.push(e)
      })(),
    )
    expect(text(seen)).toBe('Par')
    expect(finishes(seen)).toHaveLength(0)
    expect(isProviderError(error, 'rate_limited')).toBe(true)
  })

  test('abort mid-stream ends with ProviderError(aborted) and aborts the fetch', async () => {
    const f = fakeFetch({ pieces: sse(delta({ content: 'Hello' })), hang: true })
    const controller = new AbortController()
    const seen: LlmEvent[] = []
    const error = await errorOf(
      (async () => {
        for await (const e of llm(f.fetch).stream(req, controller.signal)) {
          seen.push(e)
          setTimeout(() => controller.abort(), 5)
        }
      })(),
    )
    expect(seen).toEqual([{ type: 'text.delta', text: 'Hello' }])
    expect(isProviderError(error, 'aborted')).toBe(true)
    expect((error as ProviderError).retryable).toBe(false)
    expect(f.calls[0]?.signal.aborted).toBe(true)
    expect(f.cancelled).toBe(true)
  })

  test('abort while waiting for the response throws aborted', async () => {
    const controller = new AbortController()
    const f = fakeFetch(
      (call) =>
        new Promise<never>((_, reject) => {
          call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = errorOf(collect(llm(f.fetch).stream(req, controller.signal)))
    await Bun.sleep(1)
    controller.abort()
    expect(isProviderError(await pending, 'aborted')).toBe(true)
  })

  test('an already aborted signal throws aborted without fetching', async () => {
    const f = fakeFetch({ pieces: [] })
    const controller = new AbortController()
    controller.abort()
    const error = await errorOf(collect(llm(f.fetch).stream(req, controller.signal)))
    expect(isProviderError(error, 'aborted')).toBe(true)
    expect(f.calls).toHaveLength(0)
  })

  test('stopping iteration early closes the HTTP request', async () => {
    const f = fakeFetch({ pieces: sse(delta({ content: 'a' }), delta({ content: 'b' })), hang: true })
    for await (const _ of llm(f.fetch).stream(req, new AbortController().signal)) break
    expect(f.calls[0]?.signal.aborted).toBe(true)
    expect(f.cancelled).toBe(true)
  })

  test('a network failure is unavailable and retryable', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    const error = await errorOf(collect(llm(f.fetch).stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'unavailable')).toBe(true)
    expect((error as ProviderError).retryable).toBe(true)
  })

  test('a stream that ends without finish reason or [DONE] is unavailable', async () => {
    const f = fakeFetch({ pieces: sse(delta({ content: 'cut' })) })
    const error = await errorOf(collect(llm(f.fetch).stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'unavailable')).toBe(true)
  })

  test('[DONE] without a finish reason finishes with other', async () => {
    const f = fakeFetch({ pieces: sse(delta({ content: 'x' }), '[DONE]') })
    const events = await collect(llm(f.fetch).stream(req, new AbortController().signal))
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'other' })
  })

  test('a malformed chunk throws ProviderError(unknown)', async () => {
    const f = fakeFetch({ pieces: sse('{not json') })
    const error = await errorOf(collect(llm(f.fetch).stream(req, new AbortController().signal)))
    expect(isProviderError(error, 'unknown')).toBe(true)
  })

  test('mapRequest adjusts the body and mapChunk overrides chunk mapping without breaking finish', async () => {
    const f = fakeFetch({ pieces: sse({ custom: 'thought' }, delta({ content: 'ok' }, 'stop'), '[DONE]') })
    const provider = llm(f.fetch, {
      mapRequest: (body, r) => ({ ...body, vendor_flag: r.model }),
      mapChunk: (chunk) => {
        if (
          typeof chunk === 'object' &&
          chunk !== null &&
          'custom' in chunk &&
          typeof chunk.custom === 'string'
        ) {
          return [
            { type: 'reasoning.delta', text: chunk.custom },
            { type: 'finish', reason: 'length' },
          ]
        }
        return undefined
      },
    })
    const events = await collect(provider.stream(req, new AbortController().signal))
    expect(f.calls[0]?.body?.vendor_flag).toBe('vendor/model')
    expect(events).toEqual([
      { type: 'reasoning.delta', text: 'thought' },
      { type: 'text.delta', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ])
  })
})

describe('createOpenAICompatibleLlm listModels', () => {
  test('reads /models into LlmModelInfo', async () => {
    const f = fakeFetch({
      json: {
        data: [
          { id: 'a/one', context_length: 8192, supported_parameters: ['tools', 'temperature'] },
          { id: 'b', context_window: 1048576 },
        ],
      },
    })
    const models = await llm(f.fetch).listModels?.()
    expect(f.calls[0]?.url).toBe('https://api.example.test/v1/models')
    expect(models).toEqual([
      { id: 'a/one', contextWindow: 8192, supportsTools: true },
      { id: 'b', contextWindow: 1048576 },
    ])
  })

  test('maps errors like stream does', async () => {
    const f = fakeFetch({ status: 401, json: { error: { message: 'bad key' } } })
    const error = await errorOf(llm(f.fetch).listModels?.() ?? Promise.resolve())
    expect(error).toBeInstanceOf(ProviderError)
    expect(isProviderError(error, 'auth')).toBe(true)
  })
})
