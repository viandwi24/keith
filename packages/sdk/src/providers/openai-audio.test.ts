import { describe, expect, test } from 'bun:test'
import { createOpenAICompatibleStt, createOpenAICompatibleTts } from './openai-audio.ts'
import { type AudioChunk, isProviderError, ProviderError } from './types.ts'

// Synthetic bodies in the OpenAI audio API shape. Vendor fixtures live in each voice plugin's
// test/fixtures. Nothing here touches the network.

type Call = { url: string; init: RequestInit; signal: AbortSignal }

type Reply = {
  status?: number
  json?: unknown
  /** Body pieces, delivered one read at a time. */
  pieces?: Uint8Array[]
  /** Keep the body open after the last piece until cancelled. */
  hang?: boolean
}

function fakeFetch(reply: Reply | ((call: Call, index: number) => Reply)) {
  const calls: Call[] = []
  let cancelled = 0
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), init, signal: init.signal as AbortSignal }
    calls.push(call)
    const r = typeof reply === 'function' ? reply(call, calls.length - 1) : reply
    const status = r.status ?? 200
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json' } })
    }
    const pieces = [...(r.pieces ?? [])]
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = pieces.shift()
        if (next !== undefined) {
          controller.enqueue(next)
          return
        }
        if (r.hang) return new Promise<void>(() => undefined)
        controller.close()
      },
      cancel() {
        cancelled++
      },
    })
    return new Response(body, { status, headers: { 'content-type': 'application/octet-stream' } })
  }
  return {
    fetch: fn as typeof fetch,
    calls,
    get cancelled() {
      return cancelled
    },
  }
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

async function collect(stream: AsyncIterable<AudioChunk>): Promise<AudioChunk[]> {
  const out: AudioChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))

const never = () => new AbortController().signal

// 4 samples of 16-bit PCM.
const utterance = {
  data: new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]),
  codec: 'pcm16' as const,
  sampleRate: 16_000,
}

describe('createOpenAICompatibleStt', () => {
  const stt = (f: typeof fetch, apiKey: string | null = 'sk-test') =>
    createOpenAICompatibleStt({
      id: 'vendor',
      baseUrl: 'https://api.example.test/v1/',
      apiKey: apiKey ?? undefined,
      model: 'whisper-x',
      headers: { 'x-extra': '1' },
      fetch: f,
    })

  test('POSTs multipart with a valid WAV, the model, the language and prompt', async () => {
    const f = fakeFetch({ json: { text: ' Hello there. ' } })
    const result = await stt(f.fetch).transcribe?.(utterance, { language: 'en', prompt: 'Keith' }, never())
    expect(result).toEqual({ text: 'Hello there.' })

    const call = f.calls[0]
    expect(call?.url).toBe('https://api.example.test/v1/audio/transcriptions')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['x-extra']).toBe('1')
    expect(headers['content-type']).toBeUndefined()

    const form = call?.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-x')
    expect(form.get('language')).toBe('en')
    expect(form.get('prompt')).toBe('Keith')
    expect(form.get('response_format')).toBe('json')

    const file = form.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(file.type).toBe('audio/wav')
    const wav = new Uint8Array(await file.arrayBuffer())
    const view = new DataView(wav.buffer)
    expect(wav.byteLength).toBe(44 + 8)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(ascii(wav, 8, 16)).toBe('WAVEfmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(wav, 36, 40)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
    expect([...wav.slice(44)]).toEqual([...utterance.data])
  })

  test('omits language, prompt and authorization when not given; returns a reported language', async () => {
    const f = fakeFetch({ json: { text: 'hola', language: 'es' } })
    const result = await stt(f.fetch, null).transcribe?.(utterance, {}, never())
    expect(result).toEqual({ text: 'hola', language: 'es' })
    const form = f.calls[0]?.init.body as FormData
    expect(form.has('language')).toBe(false)
    expect(form.has('prompt')).toBe(false)
    expect((f.calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
  })

  test('mapRequest adjusts the form', async () => {
    const f = fakeFetch({ json: { text: 'ok' } })
    const provider = createOpenAICompatibleStt({
      id: 'vendor',
      baseUrl: 'https://api.example.test/v1',
      model: 'm',
      fetch: f.fetch,
      mapRequest: (form) => {
        form.set('temperature', '0')
        return form
      },
    })
    await provider.transcribe?.(utterance, {}, never())
    expect((f.calls[0]?.init.body as FormData | undefined)?.get('temperature')).toBe('0')
  })

  test('maps 401 to auth and 429 to rate_limited, without retrying', async () => {
    const auth = fakeFetch({ status: 401, json: { error: { message: 'Invalid API Key' } } })
    const e1 = await errorOf(stt(auth.fetch).transcribe?.(utterance, {}, never()) as Promise<unknown>)
    expect(isProviderError(e1) && e1.code).toBe('auth')
    expect(isProviderError(e1) && e1.retryable).toBe(false)
    expect(isProviderError(e1) && e1.status).toBe(401)
    expect(String((e1 as Error).message)).not.toContain('sk-test')

    const limited = fakeFetch({ status: 429, json: { error: { message: 'Rate limit reached' } } })
    const e2 = await errorOf(stt(limited.fetch).transcribe?.(utterance, {}, never()) as Promise<unknown>)
    expect(isProviderError(e2) && e2.code).toBe('rate_limited')
    expect(isProviderError(e2) && e2.retryable).toBe(true)
    expect(limited.calls).toHaveLength(1)
  })

  test('network failures are unavailable; unexpected bodies are unknown', async () => {
    const failing = (async () => {
      throw new TypeError('connection refused')
    }) as unknown as typeof fetch
    const e1 = await errorOf(stt(failing).transcribe?.(utterance, {}, never()) as Promise<unknown>)
    expect(isProviderError(e1) && e1.code).toBe('unavailable')

    const odd = fakeFetch({ json: { transcript: 'nope' } })
    const e2 = await errorOf(stt(odd.fetch).transcribe?.(utterance, {}, never()) as Promise<unknown>)
    expect(isProviderError(e2) && e2.code).toBe('unknown')
  })

  test('refuses non-pcm16 audio as bad_request without a request', async () => {
    const f = fakeFetch({ json: { text: 'x' } })
    const e = await errorOf(
      stt(f.fetch).transcribe?.({ ...utterance, codec: 'opus' }, {}, never()) as Promise<unknown>,
    )
    expect(isProviderError(e) && e.code).toBe('bad_request')
    expect(f.calls).toHaveLength(0)
  })

  test('an abort before or during the request ends with ProviderError(aborted)', async () => {
    const pre = new AbortController()
    pre.abort()
    const f = fakeFetch({ json: { text: 'x' } })
    const e1 = await errorOf(stt(f.fetch).transcribe?.(utterance, {}, pre.signal) as Promise<unknown>)
    expect(isProviderError(e1) && e1.code).toBe('aborted')
    expect(f.calls).toHaveLength(0)

    const mid = new AbortController()
    const hanging = (async () => new Promise<never>(() => undefined)) as unknown as typeof fetch
    const pending = errorOf(stt(hanging).transcribe?.(utterance, {}, mid.signal) as Promise<unknown>)
    mid.abort()
    const e2 = await pending
    expect(e2).toBeInstanceOf(ProviderError)
    expect(isProviderError(e2) && e2.code).toBe('aborted')
  })
})

describe('createOpenAICompatibleTts', () => {
  const tts = (f: typeof fetch, extra: { sampleRate?: number } = {}) =>
    createOpenAICompatibleTts({
      id: 'vendor',
      baseUrl: 'https://api.example.test/v1/',
      apiKey: 'sk-test',
      model: 'tts-x',
      voice: 'alloy',
      fetch: f,
      ...extra,
    })

  const body = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>

  test('streams body pieces as pcm16 chunks whose bytes concatenate to the body', async () => {
    const pieces = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6]), new Uint8Array([7, 8, 9, 10])]
    const f = fakeFetch({ pieces })
    const chunks = await collect(tts(f.fetch).stream('Hello.', {}, never()))
    expect(chunks).toHaveLength(3)
    for (const c of chunks) {
      expect(c.codec).toBe('pcm16')
      expect(c.sampleRate).toBe(24_000)
    }
    expect([...concat(chunks.map((c) => c.data))]).toEqual([...concat(pieces)])

    const call = f.calls[0]
    expect(call?.url).toBe('https://api.example.test/v1/audio/speech')
    expect((call?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer sk-test')
    expect((call?.init.headers as Record<string, string> | undefined)?.['content-type']).toBe(
      'application/json',
    )
    expect(body(call)).toEqual({ model: 'tts-x', input: 'Hello.', voice: 'alloy', response_format: 'pcm' })
  })

  test('keeps whole samples when body pieces split a sample; honors sampleRate', async () => {
    const pieces = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
      new Uint8Array([5, 6, 7]),
      new Uint8Array([8]),
    ]
    const f = fakeFetch({ pieces })
    const chunks = await collect(tts(f.fetch, { sampleRate: 22_050 }).stream('x', {}, never()))
    for (const c of chunks) {
      expect(c.data.byteLength % 2).toBe(0)
      expect(c.sampleRate).toBe(22_050)
    }
    expect([...concat(chunks.map((c) => c.data))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('an AsyncIterable input makes one request per piece, in order; empty pieces are skipped', async () => {
    const f = fakeFetch((_call, index) => ({ pieces: [new Uint8Array([index, index])] }))
    async function* sentences() {
      yield 'One.'
      yield '  '
      yield 'Two.'
      yield 'Three.'
    }
    const chunks = await collect(tts(f.fetch).stream(sentences(), { voice: 'nova' }, never()))
    expect(f.calls.map((c) => body(c).input)).toEqual(['One.', 'Two.', 'Three.'])
    expect(f.calls.map((c) => body(c).voice)).toEqual(['nova', 'nova', 'nova'])
    expect(chunks.map((c) => [...c.data])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
  })

  test('mapRequest adjusts the JSON body', async () => {
    const f = fakeFetch({ pieces: [new Uint8Array([0, 0])] })
    const provider = createOpenAICompatibleTts({
      id: 'vendor',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'kokoro',
      voice: 'af_heart',
      fetch: f.fetch,
      mapRequest: (b, text, opts) => ({ ...b, speed: 1.1, lang: opts.language, echo: text }),
    })
    await collect(provider.stream('Hi', { language: 'en' }, never()))
    expect(body(f.calls[0])).toMatchObject({ speed: 1.1, lang: 'en', echo: 'Hi', voice: 'af_heart' })
    expect((f.calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
  })

  test('maps HTTP errors like the LLM helper', async () => {
    const auth = fakeFetch({ status: 401, json: { error: { message: 'Incorrect API key' } } })
    const e1 = await errorOf(collect(tts(auth.fetch).stream('x', {}, never())))
    expect(isProviderError(e1) && e1.code).toBe('auth')
    const limited = fakeFetch({ status: 429, json: { error: { message: 'slow down' } } })
    const e2 = await errorOf(collect(tts(limited.fetch).stream('x', {}, never())))
    expect(isProviderError(e2) && e2.code).toBe('rate_limited')
    const down = fakeFetch({ status: 503, json: { error: { message: 'overloaded' } } })
    const e3 = await errorOf(collect(tts(down.fetch).stream('x', {}, never())))
    expect(isProviderError(e3) && e3.code).toBe('unavailable')
    expect(down.calls).toHaveLength(1)
  })

  test('aborting mid-stream throws ProviderError(aborted) and cancels the body reader', async () => {
    const f = fakeFetch({ pieces: [new Uint8Array([1, 2])], hang: true })
    const controller = new AbortController()
    const got: AudioChunk[] = []
    const error = await errorOf(
      (async () => {
        for await (const c of tts(f.fetch).stream('Hello.', {}, controller.signal)) {
          got.push(c)
          setTimeout(() => controller.abort(), 5)
        }
      })(),
    )
    expect(got).toHaveLength(1)
    expect(error).toBeInstanceOf(ProviderError)
    expect(isProviderError(error) && error.code).toBe('aborted')
    await Bun.sleep(0)
    expect(f.cancelled).toBe(1)
    expect(f.calls[0]?.signal.aborted).toBe(true)
  })

  test('aborting while waiting for the next text piece throws ProviderError(aborted)', async () => {
    const f = fakeFetch({ pieces: [new Uint8Array([1, 2])] })
    const controller = new AbortController()
    async function* slow() {
      yield 'First.'
      await new Promise<never>(() => undefined)
    }
    const pending = errorOf(collect(tts(f.fetch).stream(slow(), {}, controller.signal)))
    await Bun.sleep(5)
    controller.abort()
    const error = await pending
    expect(isProviderError(error) && error.code).toBe('aborted')
    expect(f.calls).toHaveLength(1)
  })

  test('an already aborted signal makes no request', async () => {
    const f = fakeFetch({ pieces: [] })
    const controller = new AbortController()
    controller.abort()
    const error = await errorOf(collect(tts(f.fetch).stream('x', {}, controller.signal)))
    expect(isProviderError(error) && error.code).toBe('aborted')
    expect(f.calls).toHaveLength(0)
  })

  test('stopping iteration early closes the request', async () => {
    const f = fakeFetch({ pieces: [new Uint8Array([1, 2])], hang: true })
    for await (const _ of tts(f.fetch).stream('x', {}, never())) break
    await Bun.sleep(0)
    expect(f.cancelled).toBe(1)
    expect(f.calls[0]?.signal.aborted).toBe(true)
  })
})
