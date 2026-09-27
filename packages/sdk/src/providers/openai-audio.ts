/**
 * `createOpenAICompatibleStt` / `createOpenAICompatibleTts`: an `SttProvider` and a `TtsProvider`
 * for any service that speaks the OpenAI audio API (docs/contracts/providers.md#openai-compatible-audio,
 * ADR-0013). Groq, OpenAI and speaches are thin configurations of these.
 *
 * Both follow the adapter obligations: errors are `ProviderError`s mapped like
 * `createOpenAICompatibleLlm`, an abort ends with `ProviderError('aborted')`, nothing is retried,
 * and nothing here logs.
 */
import { z } from 'zod'
import { providerErrorFromResponse } from './openai-compatible/errors.ts'
import {
  type AudioChunk,
  type AudioInput,
  isProviderError,
  ProviderError,
  type SttOptions,
  type SttProvider,
  type TtsOptions,
  type TtsProvider,
} from './types.ts'

export type OpenAICompatibleSttOptions = {
  /** Provider id, the value `voice.stt` names in config, e.g. 'groq', 'speaches'. */
  id: string
  /** The API root, e.g. 'https://api.groq.com/openai/v1'. `/audio/transcriptions` is appended. */
  baseUrl: string
  /** Sent as a bearer token. Omitted: no `authorization` header (e.g. a local speaches). */
  apiKey?: string | undefined
  /** e.g. 'whisper-large-v3-turbo'. */
  model: string
  /** Extra headers on every request. */
  headers?: Record<string, string> | undefined
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
  /** Adjusts the default multipart body (`model`, `file`, `language?`, `prompt?`, `response_format`). */
  mapRequest?: ((form: FormData, opts: SttOptions) => FormData) | undefined
}

export type OpenAICompatibleTtsOptions = {
  /** Provider id, the value `voice.tts` names in config, e.g. 'openai', 'speaches'. */
  id: string
  /** The API root, e.g. 'https://api.openai.com/v1'. `/audio/speech` is appended. */
  baseUrl: string
  /** Sent as a bearer token. Omitted: no `authorization` header (e.g. a local speaches). */
  apiKey?: string | undefined
  /** e.g. 'gpt-4o-mini-tts'. */
  model: string
  /** Default voice; `TtsOptions.voice` overrides it per call. */
  voice: string
  /** Rate of the `pcm` the service returns, in Hz. Default 24000. */
  sampleRate?: number | undefined
  /** Extra headers on every request. */
  headers?: Record<string, string> | undefined
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
  /** Adjusts the default JSON body (`model`, `input`, `voice`, `response_format: "pcm"`). */
  mapRequest?:
    | ((body: Record<string, unknown>, text: string, opts: TtsOptions) => Record<string, unknown>)
    | undefined
}

/** The default rate of `response_format: "pcm"` from OpenAI and Kokoro. */
const DEFAULT_TTS_SAMPLE_RATE = 24_000

type Common = {
  id: string
  base: string
  apiKey?: string | undefined
  headers?: Record<string, string> | undefined
  fetch?: typeof fetch | undefined
}

function common(opts: Omit<Common, 'base'> & { baseUrl: string }): Common {
  return {
    id: opts.id,
    base: opts.baseUrl.replace(/\/+$/, ''),
    apiKey: opts.apiKey,
    headers: opts.headers,
    fetch: opts.fetch,
  }
}

function headersFor(ctx: Common, accept: string): Record<string, string> {
  const headers: Record<string, string> = { ...ctx.headers, accept }
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`
  return headers
}

function abortedError(ctx: Common, signal: AbortSignal): ProviderError {
  return new ProviderError('aborted', `${ctx.id}: aborted`, { cause: signal.reason })
}

type AbortRace = { promise: Promise<never>; dispose(): void }

/**
 * A promise that rejects with `ProviderError('aborted')` once `signal` aborts and never resolves.
 * `dispose` removes the listener, so long-lived signals don't collect one listener per call.
 */
function abortRace(ctx: Common, signal: AbortSignal, reportAs: AbortSignal = signal): AbortRace {
  let fail: () => void = () => undefined
  const promise = new Promise<never>((_, reject) => {
    fail = () => reject(abortedError(ctx, reportAs))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
  // Observed by the races that use it; this only keeps an unraced rejection from being reported.
  promise.catch(() => undefined)
  return { promise, dispose: () => signal.removeEventListener('abort', fail) }
}

/** Races `work` against `signal`, always removing the listener afterwards. */
async function raceAbort<T>(ctx: Common, signal: AbortSignal, work: Promise<T>): Promise<T> {
  const race = abortRace(ctx, signal)
  try {
    return await Promise.race([work, race.promise])
  } finally {
    race.dispose()
  }
}

async function send(ctx: Common, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch
  let response: Response
  try {
    response = await raceAbort(ctx, signal, doFetch(url, { ...init, signal }))
  } catch (cause) {
    if (signal.aborted) throw abortedError(ctx, signal)
    throw new ProviderError('unavailable', `${ctx.id}: request failed`, { cause })
  }
  if (!response.ok) throw await providerErrorFromResponse(ctx.id, response)
  return response
}

// ---------------------------------------------------------------------------------------------
// STT

/** Wraps 16-bit little-endian mono PCM in a 44-byte canonical WAV (RIFF) header. */
function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const wav = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(wav.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  const channels = 1
  const bytesPerSample = 2
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true) // byte rate
  view.setUint16(32, channels * bytesPerSample, true) // block align
  view.setUint16(34, bytesPerSample * 8, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  wav.set(pcm, 44)
  return wav
}

const transcriptionSchema = z.object({ text: z.string(), language: z.string().optional() })

export function createOpenAICompatibleStt(opts: OpenAICompatibleSttOptions): SttProvider {
  const ctx = common(opts)
  return {
    id: opts.id,
    transcribe: (audio, sttOpts, signal) => transcribe(ctx, opts, audio, sttOpts, signal),
  }
}

async function transcribe(
  ctx: Common,
  opts: OpenAICompatibleSttOptions,
  audio: AudioInput,
  sttOpts: SttOptions,
  signal: AbortSignal,
): Promise<{ text: string; language?: string | undefined }> {
  if (signal.aborted) throw abortedError(ctx, signal)
  if (audio.codec !== 'pcm16') {
    throw new ProviderError('bad_request', `${ctx.id}: only pcm16 audio can be transcribed`)
  }
  const wav = pcm16ToWav(audio.data, audio.sampleRate)
  const defaults = new FormData()
  defaults.set('model', opts.model)
  defaults.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  defaults.set('response_format', 'json')
  if (sttOpts.language) defaults.set('language', sttOpts.language)
  if (sttOpts.prompt) defaults.set('prompt', sttOpts.prompt)
  const form = opts.mapRequest ? opts.mapRequest(defaults, sttOpts) : defaults
  // No content-type: fetch sets the multipart boundary itself.
  const init: RequestInit = { method: 'POST', headers: headersFor(ctx, 'application/json'), body: form }
  const response = await send(ctx, `${ctx.base}/audio/transcriptions`, init, signal)
  let json: unknown
  try {
    json = await raceAbort(ctx, signal, response.json())
  } catch (cause) {
    if (signal.aborted) throw abortedError(ctx, signal)
    throw new ProviderError('unknown', `${ctx.id}: malformed transcription response`, { cause })
  }
  const parsed = transcriptionSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProviderError('unknown', `${ctx.id}: unexpected transcription response`, {
      cause: parsed.error,
    })
  }
  const text = parsed.data.text.trim()
  return parsed.data.language ? { text, language: parsed.data.language } : { text }
}

// ---------------------------------------------------------------------------------------------
// TTS

export function createOpenAICompatibleTts(opts: OpenAICompatibleTtsOptions): TtsProvider {
  const ctx = common(opts)
  return {
    id: opts.id,
    stream: (text, ttsOpts, signal) => streamSpeech(ctx, opts, text, ttsOpts, signal),
  }
}

async function* pieces(text: AsyncIterable<string> | string): AsyncGenerator<string> {
  if (typeof text === 'string') yield text
  else yield* text
}

async function* streamSpeech(
  ctx: Common,
  opts: OpenAICompatibleTtsOptions,
  text: AsyncIterable<string> | string,
  ttsOpts: TtsOptions,
  signal: AbortSignal,
): AsyncGenerator<AudioChunk> {
  if (signal.aborted) throw abortedError(ctx, signal)
  const source = pieces(text)
  try {
    while (true) {
      let next: IteratorResult<string>
      try {
        next = await raceAbort(ctx, signal, source.next())
      } catch (cause) {
        if (signal.aborted) throw abortedError(ctx, signal)
        throw cause
      }
      if (next.done) return
      // An empty `input` is a 400 at every vendor; there is nothing to say.
      if (next.value.trim() === '') continue
      yield* speakPiece(ctx, opts, next.value, ttsOpts, signal)
    }
  } finally {
    // We stopped consuming the text source; let it clean up. Not awaited: a pending `next()`
    // would delay it until the producer yields again.
    source.return(undefined).catch(() => undefined)
  }
}

async function* speakPiece(
  ctx: Common,
  opts: OpenAICompatibleTtsOptions,
  input: string,
  ttsOpts: TtsOptions,
  signal: AbortSignal,
): AsyncGenerator<AudioChunk> {
  // Our own controller also closes the HTTP request when the consumer stops iterating early.
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  let reader: { cancel(): Promise<void> } | undefined
  try {
    const defaults: Record<string, unknown> = {
      model: opts.model,
      input,
      voice: ttsOpts.voice ?? opts.voice,
      response_format: 'pcm',
    }
    const body = opts.mapRequest ? opts.mapRequest(defaults, input, ttsOpts) : defaults
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...headersFor(ctx, 'audio/pcm, application/octet-stream'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }
    const response = await send(ctx, `${ctx.base}/audio/speech`, init, controller.signal)
    if (!response.body) throw new ProviderError('unavailable', `${ctx.id}: empty response body`)
    const activeReader = response.body.getReader()
    reader = activeReader
    // Disposal is unnecessary: `controller` is local and aborted in `finally`.
    const aborted = abortRace(ctx, controller.signal, signal)
    const sampleRate = opts.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE
    // A body chunk may end mid-sample; carry the odd byte so every AudioChunk holds whole samples.
    let carry: number | undefined
    while (true) {
      let result: Awaited<ReturnType<typeof activeReader.read>>
      try {
        result = await Promise.race([activeReader.read(), aborted.promise])
      } catch (cause) {
        if (signal.aborted) throw abortedError(ctx, signal)
        if (isProviderError(cause)) throw cause
        throw new ProviderError('unavailable', `${ctx.id}: stream interrupted`, { cause })
      }
      if (result.done) break
      let bytes = result.value
      if (carry !== undefined) {
        const joined = new Uint8Array(bytes.byteLength + 1)
        joined[0] = carry
        joined.set(bytes, 1)
        bytes = joined
        carry = undefined
      }
      if (bytes.byteLength % 2 === 1) {
        carry = bytes[bytes.byteLength - 1]
        bytes = bytes.subarray(0, bytes.byteLength - 1)
      }
      if (bytes.byteLength === 0) continue
      yield { data: bytes, codec: 'pcm16', sampleRate }
      if (signal.aborted) throw abortedError(ctx, signal)
    }
    // A trailing odd byte is half a sample: it cannot be played, so it is dropped.
  } finally {
    signal.removeEventListener('abort', onAbort)
    controller.abort()
    // Cancelling an already closed or errored stream rejects; there is nothing left to release.
    reader?.cancel().catch(() => undefined)
  }
}
