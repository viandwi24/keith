// The voice pipeline (phase 3): VAD -> STT per node stream, TTS per spoken reply.
// See docs/architecture/voice.md and ADR-0013.

import type { VoiceDeps } from './deps.ts'
import { createVoiceInput } from './input.ts'
import { createVoiceOutput } from './output.ts'
import type { VoiceInput, VoiceOutput } from './types.ts'

export { checkVoiceProviders } from './check.ts'
export type { VoiceDeps } from './deps.ts'
export { AUDIO_OUT_CAPABILITY } from './output.ts'
export type { SpeechHandle, VoiceInput, VoiceOutput, VoiceStartResult } from './types.ts'

/**
 * Builds both halves of the pipeline. With `config: undefined` (no `[voice]`), `input.start`
 * refuses every stream and `output.begin` returns null.
 */
export function createVoice(deps: VoiceDeps): { input: VoiceInput; output: VoiceOutput } {
  return { input: createVoiceInput(deps), output: createVoiceOutput(deps) }
}
