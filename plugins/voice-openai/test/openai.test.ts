import { describe, expect, test } from 'bun:test'
import { type AudioChunk, isKeithError, isProviderError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createOpenAITts, OPENAI_BASE_URL, OPENAI_TTS_MODEL, OPENAI_TTS_VOICE } from '../src/index.ts'
import { fixtureBytes, replay } from './replay.ts'

// speech.pcm: 10 ms of a 440 Hz sine, 24 kHz pcm16 (synthetic; the shape `response_format: "pcm"`
// returns). The replay streams it in 37-byte pieces, so pieces split samples.

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

function concat(chunks: AudioChunk[]): number[] {
  return chunks.flatMap((c) => [...c.data])
}

const never = () => new AbortController().signal
const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>

describe('@keith/voice-openai plugin', () => {
  test('registers exactly one TTS provider with id openai, and nothing else', async () => {
    const ctx = await setupFakePlugin(plugin, { config: { apiKey: 'sk-test' } })
    expect(ctx.recorded.tts.map((p) => p.id)).toEqual(['openai'])
    expect(ctx.recorded.stt).toHaveLength(0)
    expect(ctx.recorded.llm).toHaveLength(0)
  })

  test('applies defaults for baseUrl, model and voice', () => {
    expect(plugin.config?.parse({ apiKey: 'sk-test' })).toEqual({
      apiKey: 'sk-test',
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
    })
  })

  test('rejects config without an apiKey or with an empty voice', async () => {
    const e1 = await errorOf(setupFakePlugin(plugin, { config: { voice: 'nova' } }))
    expect(isKeithError(e1, 'CONFIG_INVALID')).toBe(true)
    const e2 = await errorOf(setupFakePlugin(plugin, { config: { apiKey: 'k', voice: '' } }))
    expect(isKeithError(e2, 'CONFIG_INVALID')).toBe(true)
  })
})

describe('OpenAI TTS (synthetic fixtures)', () => {
  test('chunked PCM body becomes 24 kHz pcm16 chunks whose bytes equal the fixture', async () => {
    const r = replay('speech.pcm')
    const tts = createOpenAITts({ apiKey: 'sk-test', voice: 'coral', fetch: r.fetch })
    const chunks = await collect(tts.stream('Hello there.', {}, never()))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.codec).toBe('pcm16')
      expect(c.sampleRate).toBe(24_000)
      expect(c.data.byteLength % 2).toBe(0)
    }
    expect(concat(chunks)).toEqual([...(await fixtureBytes('speech.pcm'))])
    const req = r.requests[0]
    expect(req?.url).toBe(`${OPENAI_BASE_URL}/audio/speech`)
    expect((req?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer sk-test')
    expect(body(req?.init)).toEqual({
      model: OPENAI_TTS_MODEL,
      input: 'Hello there.',
      voice: 'coral',
      response_format: 'pcm',
    })
  })

  test('an AsyncIterable of sentences makes one request per sentence, in order', async () => {
    const r = replay('speech.pcm')
    async function* sentences() {
      yield 'First sentence.'
      yield 'Second sentence.'
    }
    const chunks = await collect(
      createOpenAITts({ apiKey: 'sk-test', fetch: r.fetch }).stream(sentences(), { voice: 'nova' }, never()),
    )
    expect(r.requests.map((q) => body(q.init).input)).toEqual(['First sentence.', 'Second sentence.'])
    expect(r.requests.map((q) => body(q.init).voice)).toEqual(['nova', 'nova'])
    const pcm = [...(await fixtureBytes('speech.pcm'))]
    expect(concat(chunks)).toEqual([...pcm, ...pcm])
  })

  test('401 maps to auth and 429 to rate_limited', async () => {
    const auth = replay('error-401.json')
    const e1 = await errorOf(
      collect(createOpenAITts({ apiKey: 'sk-bad', fetch: auth.fetch }).stream('x', {}, never())),
    )
    expect(isProviderError(e1) && e1.code).toBe('auth')
    const limited = replay('error-429.json')
    const e2 = await errorOf(
      collect(createOpenAITts({ apiKey: 'sk-test', fetch: limited.fetch }).stream('x', {}, never())),
    )
    expect(isProviderError(e2) && e2.code).toBe('rate_limited')
  })

  test('aborting mid-stream throws ProviderError(aborted) and cancels the body reader', async () => {
    const r = replay('speech.pcm')
    const controller = new AbortController()
    let seen = 0
    const error = await errorOf(
      (async () => {
        for await (const _ of createOpenAITts({ apiKey: 'sk-test', fetch: r.fetch }).stream(
          'x',
          {},
          controller.signal,
        )) {
          seen++
          controller.abort()
        }
      })(),
    )
    expect(seen).toBe(1)
    expect(isProviderError(error) && error.code).toBe('aborted')
    await Bun.sleep(0)
    expect(r.cancelled).toBe(1)
  })
})
