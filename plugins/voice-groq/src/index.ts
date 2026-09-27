/** `@keith/voice-groq`: Groq's hosted Whisper behind the `SttProvider` seam (ADR-0013). */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { createGroqStt, GROQ_BASE_URL, GROQ_STT_MODEL } from './provider.ts'

export { createGroqStt, GROQ_BASE_URL, GROQ_STT_MODEL, type GroqSttOptions } from './provider.ts'

export const groqVoiceConfig = z.object({
  /** Usually `"env:GROQ_API_KEY"`; the core resolves `env:` references before validation. */
  apiKey: z.string().min(1),
  baseUrl: z.url().default(GROQ_BASE_URL),
  model: z.string().min(1).default(GROQ_STT_MODEL),
})

export default definePlugin({
  id: '@keith/voice-groq',
  // Not 'groq': that stays free for a future Groq LLM plugin.
  namespace: 'voice_groq',
  version: '0.0.0',
  kind: 'provider',
  config: groqVoiceConfig,
  setup(ctx) {
    ctx.providers.stt.register(
      createGroqStt({ apiKey: ctx.config.apiKey, baseUrl: ctx.config.baseUrl, model: ctx.config.model }),
    )
  },
})
