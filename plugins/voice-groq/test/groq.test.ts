import { describe, expect, test } from 'bun:test'
import { isKeithError, isProviderError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createGroqStt, GROQ_BASE_URL, GROQ_STT_MODEL } from '../src/index.ts'
import { replay } from './replay.ts'

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

const utterance = { data: new Uint8Array(3200), codec: 'pcm16' as const, sampleRate: 16_000 }
const never = () => new AbortController().signal

describe('@keith/voice-groq plugin', () => {
  test('registers exactly one STT provider with id groq, and nothing else', async () => {
    const ctx = await setupFakePlugin(plugin, { config: { apiKey: 'gsk-test' } })
    expect(ctx.recorded.stt.map((p) => p.id)).toEqual(['groq'])
    expect(ctx.recorded.tts).toHaveLength(0)
    expect(ctx.recorded.llm).toHaveLength(0)
    expect(typeof ctx.recorded.stt[0]?.transcribe).toBe('function')
  })

  test('applies defaults for baseUrl and model', () => {
    const config = plugin.config?.parse({ apiKey: 'gsk-test' })
    expect(config).toEqual({ apiKey: 'gsk-test', baseUrl: GROQ_BASE_URL, model: GROQ_STT_MODEL })
  })

  test('rejects config without an apiKey or with a bad baseUrl', async () => {
    const e1 = await errorOf(setupFakePlugin(plugin, { config: {} }))
    expect(isKeithError(e1, 'CONFIG_INVALID')).toBe(true)
    const e2 = await errorOf(setupFakePlugin(plugin, { config: { apiKey: 'k', baseUrl: 'not a url' } }))
    expect(isKeithError(e2, 'CONFIG_INVALID')).toBe(true)
  })
})

describe('Groq STT (synthetic fixtures)', () => {
  test('transcribes: posts a WAV with model and language to Groq, returns trimmed text', async () => {
    const r = replay('transcription.json')
    const stt = createGroqStt({ apiKey: 'gsk-test', fetch: r.fetch })
    const result = await stt.transcribe?.(utterance, { language: 'en' }, never())
    expect(result).toEqual({ text: "What's the weather like in Lisbon tomorrow?" })
    const req = r.requests[0]
    expect(req?.url).toBe(`${GROQ_BASE_URL}/audio/transcriptions`)
    expect((req?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer gsk-test')
    const form = req?.init.body as FormData
    expect(form.get('model')).toBe(GROQ_STT_MODEL)
    expect(form.get('language')).toBe('en')
    const wav = new Uint8Array(await (form.get('file') as File).arrayBuffer())
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(wav.byteLength).toBe(44 + utterance.data.byteLength)
  })

  test('401 maps to auth and 429 to rate_limited', async () => {
    const auth = replay('error-401.json')
    const e1 = await errorOf(
      createGroqStt({ apiKey: 'gsk-bad', fetch: auth.fetch }).transcribe?.(
        utterance,
        {},
        never(),
      ) as Promise<unknown>,
    )
    expect(isProviderError(e1) && e1.code).toBe('auth')
    expect(String((e1 as Error).message)).not.toContain('gsk-bad')

    const limited = replay('error-429.json')
    const e2 = await errorOf(
      createGroqStt({ apiKey: 'gsk-test', fetch: limited.fetch }).transcribe?.(
        utterance,
        {},
        never(),
      ) as Promise<unknown>,
    )
    expect(isProviderError(e2) && e2.code).toBe('rate_limited')
    expect(isProviderError(e2) && e2.retryable).toBe(true)
  })
})
