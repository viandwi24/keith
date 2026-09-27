/**
 * `@keith/voice-speaches`: local STT (faster-whisper) and TTS (Kokoro) from one self-hosted
 * speaches container, behind the `SttProvider` and `TtsProvider` seams (ADR-0013).
 */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { createSpeachesStt, createSpeachesTts } from './provider.ts'

export {
  createSpeachesStt,
  createSpeachesTts,
  type SpeachesSttOptions,
  type SpeachesTtsOptions,
} from './provider.ts'

export const SPEACHES_BASE_URL = 'http://127.0.0.1:8000/v1'

// Model and voice ids as speaches' docs show them (https://speaches.ai/usage/, checked 2026-09-27).
// They change between speaches releases: override them in config rather than here.
export const speachesConfig = z.object({
  baseUrl: z.url().default(SPEACHES_BASE_URL),
  /** Only when the server was started with an API key; e.g. `"env:SPEACHES_API_KEY"`. */
  apiKey: z.string().min(1).optional(),
  /** A faster-whisper model id. */
  sttModel: z.string().min(1).default('Systran/faster-whisper-small'),
  /** A speaches TTS model id. */
  ttsModel: z.string().min(1).default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  /** Default voice; `TtsOptions.voice` overrides it per call. */
  voice: z.string().min(1).default('af_heart'),
  /** Rate of the `pcm` the TTS model returns, in Hz. Kokoro renders at 24000. */
  sampleRate: z.number().int().positive().default(24_000),
})

export default definePlugin({
  id: '@keith/voice-speaches',
  namespace: 'speaches',
  version: '0.0.0',
  kind: 'provider',
  config: speachesConfig,
  setup(ctx) {
    const { baseUrl, apiKey } = ctx.config
    ctx.providers.stt.register(createSpeachesStt({ baseUrl, apiKey, model: ctx.config.sttModel }))
    ctx.providers.tts.register(
      createSpeachesTts({
        baseUrl,
        apiKey,
        model: ctx.config.ttsModel,
        voice: ctx.config.voice,
        sampleRate: ctx.config.sampleRate,
      }),
    )
  },
})
