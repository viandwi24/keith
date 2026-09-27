/// <reference lib="dom" />
import { type MicCapture, openMic } from './mic.ts'
import { type AudioOutput, createAudioOutput } from './web-audio.ts'

/**
 * What the chat screen needs from the platform for voice: the mic and a speaker. `browserVoice()`
 * is the real one; component tests pass a fake. When `unavailable` is set, the app declares no
 * audio capability and shows the reason instead of a working mic button.
 */
export type VoiceEnv = {
  /** Why voice cannot work in this page, or null when it can. */
  unavailable: string | null
  openMic(onChunk: (pcm16: Int16Array) => void): Promise<MicCapture>
  createOutput(): AudioOutput
}

export function voiceUnavailableReason(scope: typeof globalThis = globalThis): string | null {
  const g = scope as typeof globalThis & { isSecureContext?: boolean }
  if (typeof g.AudioContext !== 'function') return 'This browser cannot play or record audio.'
  // Browsers expose the mic and AudioWorklet only to secure pages (HTTPS or localhost).
  if (g.isSecureContext === false) return 'Voice needs HTTPS or localhost. Text chat still works.'
  if (typeof g.AudioWorkletNode !== 'function' || !g.navigator?.mediaDevices?.getUserMedia) {
    return 'This browser cannot record audio here. Text chat still works.'
  }
  return null
}

export function browserVoice(): VoiceEnv {
  return {
    unavailable: voiceUnavailableReason(),
    openMic,
    createOutput: () => createAudioOutput(),
  }
}
