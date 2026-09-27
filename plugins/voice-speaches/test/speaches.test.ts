import { describe, expect, test } from 'bun:test'
import { type AudioChunk, isKeithError, isProviderError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createSpeachesStt, createSpeachesTts, SPEACHES_BASE_URL } from '../src/index.ts'
import { fixtureBytes, replay } from './replay.ts'

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

const never = () => new AbortController().signal
const utterance = { data: new Uint8Array(640), codec: 'pcm16' as const, sampleRate: 16_000 }

describe('@keith/voice-speaches plugin', () => {
  test('registers one STT and one TTS provider, both with id speaches', async () => {
    const ctx = await setupFakePlugin(plugin, { config: {} })
    expect(ctx.recorded.stt.map((p) => p.id)).toEqual(['speaches'])
    expect(ctx.recorded.tts.map((p) => p.id)).toEqual(['speaches'])
    expect(ctx.recorded.llm).toHaveLength(0)
  })

  test('needs no config: defaults point at a local server without a key', () => {
    const config = plugin.config?.parse({})
    expect(config?.baseUrl).toBe(SPEACHES_BASE_URL)
    expect(config?.apiKey).toBeUndefined()
    expect(config?.sampleRate).toBe(24_000)
    expect(config?.sttModel).toBeTruthy()
    expect(config?.ttsModel).toBeTruthy()
    expect(config?.voice).toBeTruthy()
  })

  test('rejects an invalid config', async () => {
    const e1 = await errorOf(setupFakePlugin(plugin, { config: { baseUrl: 'localhost' } }))
    expect(isKeithError(e1, 'CONFIG_INVALID')).toBe(true)
    const e2 = await errorOf(setupFakePlugin(plugin, { config: { sampleRate: 0 } }))
    expect(isKeithError(e2, 'CONFIG_INVALID')).toBe(true)
    const e3 = await errorOf(setupFakePlugin(plugin, { config: { apiKey: '' } }))
    expect(isKeithError(e3, 'CONFIG_INVALID')).toBe(true)
  })
})

describe('speaches (synthetic fixtures)', () => {
  test('STT posts to the local server without authorization and returns the text', async () => {
    const r = replay('transcription.json')
    const stt = createSpeachesStt({ baseUrl: SPEACHES_BASE_URL, model: 'whisper-m', fetch: r.fetch })
    expect(await stt.transcribe?.(utterance, {}, never())).toEqual({ text: 'Turn off the kitchen lights.' })
    const req = r.requests[0]
    expect(req?.url).toBe(`${SPEACHES_BASE_URL}/audio/transcriptions`)
    expect((req?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
    expect((req?.init.body as FormData | undefined)?.get('model')).toBe('whisper-m')
  })

  test('TTS streams pcm16 at the configured rate; bytes equal the fixture', async () => {
    const r = replay('speech.pcm', { pieceSize: 101 })
    const tts = createSpeachesTts({
      baseUrl: SPEACHES_BASE_URL,
      apiKey: 'local-key',
      model: 'kokoro',
      voice: 'af_heart',
      sampleRate: 24_000,
      fetch: r.fetch,
    })
    const chunks = await collect(tts.stream('Done.', {}, never()))
    expect(chunks.every((c) => c.codec === 'pcm16' && c.sampleRate === 24_000)).toBe(true)
    expect(chunks.flatMap((c) => [...c.data])).toEqual([...(await fixtureBytes('speech.pcm'))])
    const req = r.requests[0]
    expect(req?.url).toBe(`${SPEACHES_BASE_URL}/audio/speech`)
    expect((req?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer local-key')
    expect(JSON.parse(String(req?.init.body))).toEqual({
      model: 'kokoro',
      input: 'Done.',
      voice: 'af_heart',
      response_format: 'pcm',
    })
  })

  test('an unknown model (404) maps to bad_request', async () => {
    const r = replay('model-not-found.json')
    const tts = createSpeachesTts({
      baseUrl: SPEACHES_BASE_URL,
      model: 'speaches-ai/unknown',
      voice: 'af_heart',
      sampleRate: 24_000,
      fetch: r.fetch,
    })
    const error = await errorOf(collect(tts.stream('x', {}, never())))
    expect(isProviderError(error) && error.code).toBe('bad_request')
    expect(isProviderError(error) && error.status).toBe(404)
  })
})
