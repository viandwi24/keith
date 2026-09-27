/** `@keith/voice-openai`: OpenAI speech behind the `TtsProvider` seam (ADR-0013). */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { createOpenAITts, OPENAI_BASE_URL, OPENAI_TTS_MODEL, OPENAI_TTS_VOICE } from './provider.ts'

export {
  createOpenAITts,
  OPENAI_BASE_URL,
  OPENAI_PCM_SAMPLE_RATE,
  OPENAI_TTS_MODEL,
  OPENAI_TTS_VOICE,
  type OpenAITtsOptions,
} from './provider.ts'

export const openAIVoiceConfig = z.object({
  /** Usually `"env:OPENAI_API_KEY"`; the core resolves `env:` references before validation. */
  apiKey: z.string().min(1),
  baseUrl: z.url().default(OPENAI_BASE_URL),
  model: z.string().min(1).default(OPENAI_TTS_MODEL),
  /** Default voice; `TtsOptions.voice` overrides it per call. */
  voice: z.string().min(1).default(OPENAI_TTS_VOICE),
})

export default definePlugin({
  id: '@keith/voice-openai',
  // Not 'openai': that stays free for a future OpenAI LLM plugin.
  namespace: 'voice_openai',
  version: '0.0.0',
  kind: 'provider',
  config: openAIVoiceConfig,
  setup(ctx) {
    ctx.providers.tts.register(
      createOpenAITts({
        apiKey: ctx.config.apiKey,
        baseUrl: ctx.config.baseUrl,
        model: ctx.config.model,
        voice: ctx.config.voice,
      }),
    )
  },
})
