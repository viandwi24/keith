/**
 * `createOpenAICompatibleStt` / `createOpenAICompatibleTts`: an `SttProvider` and a `TtsProvider`
 * for any service that speaks the OpenAI audio API (docs/contracts/providers.md#openai-compatible-audio,
 * ADR-0013).
 *
 * P3-K1 fixed the signatures. The bodies are placeholders that throw until P3-B1 implements them.
 */
import type { SttOptions, SttProvider, TtsOptions, TtsProvider } from './types.ts'

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

function notImplemented(name: string): Error {
  return new Error(`${name} is not implemented yet (task P3-B1)`)
}

export function createOpenAICompatibleStt(opts: OpenAICompatibleSttOptions): SttProvider {
  return {
    id: opts.id,
    transcribe: async () => {
      throw notImplemented('createOpenAICompatibleStt')
    },
  }
}

export function createOpenAICompatibleTts(opts: OpenAICompatibleTtsOptions): TtsProvider {
  return {
    id: opts.id,
    // biome-ignore lint/correctness/useYield: placeholder until P3-B1.
    stream: async function* () {
      throw notImplemented('createOpenAICompatibleTts')
    },
  }
}
