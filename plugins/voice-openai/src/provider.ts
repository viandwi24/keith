/** The OpenAI `TtsProvider`: a configuration of the SDK's OpenAI-compatible TTS helper. */
import { createOpenAICompatibleTts, type TtsProvider } from '@keith/sdk'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
export const OPENAI_TTS_VOICE = 'alloy'
/** OpenAI's `response_format: "pcm"` is 24 kHz, 16-bit signed little-endian mono. */
export const OPENAI_PCM_SAMPLE_RATE = 24_000

export type OpenAITtsOptions = {
  apiKey: string
  baseUrl?: string | undefined
  model?: string | undefined
  voice?: string | undefined
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

export function createOpenAITts(opts: OpenAITtsOptions): TtsProvider {
  return createOpenAICompatibleTts({
    id: 'openai',
    baseUrl: opts.baseUrl ?? OPENAI_BASE_URL,
    apiKey: opts.apiKey,
    model: opts.model ?? OPENAI_TTS_MODEL,
    voice: opts.voice ?? OPENAI_TTS_VOICE,
    sampleRate: OPENAI_PCM_SAMPLE_RATE,
    fetch: opts.fetch,
  })
}
