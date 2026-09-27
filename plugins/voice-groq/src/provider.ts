/** The Groq `SttProvider`: a configuration of the SDK's OpenAI-compatible STT helper. */
import { createOpenAICompatibleStt, type SttProvider } from '@keith/sdk'

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
export const GROQ_STT_MODEL = 'whisper-large-v3-turbo'

export type GroqSttOptions = {
  apiKey: string
  baseUrl?: string | undefined
  model?: string | undefined
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

export function createGroqStt(opts: GroqSttOptions): SttProvider {
  return createOpenAICompatibleStt({
    id: 'groq',
    baseUrl: opts.baseUrl ?? GROQ_BASE_URL,
    apiKey: opts.apiKey,
    model: opts.model ?? GROQ_STT_MODEL,
    fetch: opts.fetch,
  })
}
