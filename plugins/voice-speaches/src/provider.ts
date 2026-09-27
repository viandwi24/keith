/**
 * The speaches `SttProvider` and `TtsProvider`: configurations of the SDK's OpenAI-compatible
 * audio helpers for a self-hosted speaches server (https://speaches.ai/).
 *
 * speaches' model and voice ids change between releases, so the defaults live in the plugin's
 * config schema (`src/index.ts`), not here: these constructors take every id explicitly.
 */
import {
  createOpenAICompatibleStt,
  createOpenAICompatibleTts,
  type SttProvider,
  type TtsProvider,
} from '@keith/sdk'

export type SpeachesSttOptions = {
  baseUrl: string
  /** Only when the server was started with an API key. */
  apiKey?: string | undefined
  model: string
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

export type SpeachesTtsOptions = {
  baseUrl: string
  apiKey?: string | undefined
  model: string
  voice: string
  /** Rate of the `pcm` the model returns, in Hz (Kokoro: 24000). */
  sampleRate: number
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

export function createSpeachesStt(opts: SpeachesSttOptions): SttProvider {
  return createOpenAICompatibleStt({
    id: 'speaches',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    fetch: opts.fetch,
  })
}

export function createSpeachesTts(opts: SpeachesTtsOptions): TtsProvider {
  return createOpenAICompatibleTts({
    id: 'speaches',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    voice: opts.voice,
    sampleRate: opts.sampleRate,
    fetch: opts.fetch,
  })
}
