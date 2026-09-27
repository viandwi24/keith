// In-memory fakes for voice/ tests only (docs/rules/conventions.md#tests). Built from
// mind/types.ts, server/types.ts and the SDK provider interfaces. The integration task (P3-I1)
// re-runs the key paths against the real implementations.

import type { CoreFrame } from '@keith/protocol'
import {
  type AudioChunk,
  ProviderError,
  type SttProvider,
  type TtsProvider,
  type VadEvent,
  type VadProvider,
} from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { VoiceConfig } from '../config/types.ts'
import type { IdPrefix, Ids, Modality, NodeId, PersonId, ThreadId } from '../shared/types.ts'
import type { VoiceDeps } from './deps.ts'
import { pcm16ToBytes } from './pcm.ts'

export const nodeId = (n: number) => `nod_${String(n).padStart(26, '0')}` as NodeId
export const personId = (n: number) => `per_${String(n).padStart(26, '0')}` as PersonId
export const threadId = (n: number) => `thr_${String(n).padStart(26, '0')}` as ThreadId
export const streamId = (n: number) => String(n).padStart(26, '0')

export function createFakeIds(): Ids {
  let seq = 0
  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      seq += 1
      return `${prefix}_${String(seq).padStart(26, '0')}`
    },
  }
}

/** Speech when a chunk's first sample is above `LOUD / 2`. Events on transitions, per chunk. */
export const LOUD = 8_000

export function createFakeVad(): VadProvider & { rates: number[]; closed: number } {
  const fake = {
    id: 'fake-vad',
    rates: [] as number[],
    closed: 0,
    create({ sampleRate }: { sampleRate: number }) {
      fake.rates.push(sampleRate)
      let speaking = false
      let samples = 0
      return {
        push(pcm: Int16Array): VadEvent[] {
          samples += pcm.length
          const atMs = (samples * 1000) / sampleRate
          const loud = Math.abs(pcm[0] ?? 0) > LOUD / 2
          if (loud === speaking) return []
          speaking = loud
          return [{ type: loud ? 'speech.start' : 'speech.end', atMs }]
        },
        close() {
          fake.closed += 1
        },
      }
    },
  }
  return fake
}

export type SttCall = { samples: number; sampleRate: number; codec: string; language: string | undefined }

export function createFakeStt(texts: string[] | (() => string)): SttProvider & { calls: SttCall[] } {
  const calls: SttCall[] = []
  let i = 0
  return {
    id: 'fake-stt',
    calls,
    async transcribe(audio, opts) {
      calls.push({
        samples: audio.data.byteLength / 2,
        sampleRate: audio.sampleRate,
        codec: audio.codec,
        language: opts.language,
      })
      const text = typeof texts === 'function' ? texts() : (texts[i] ?? '')
      i += 1
      return { text }
    },
  }
}

/** A TTS that yields `chunksPerText` chunks of `samplesPerChunk` samples per text. */
export function createFakeTts(
  opts: {
    sampleRate?: number
    chunksPerText?: number
    samplesPerChunk?: number
    /** Texts (1-based call index) whose chunks after the first wait until the call is aborted. */
    holdText?: number
    failOn?: string
  } = {},
): TtsProvider & { texts: string[]; signals: AbortSignal[] } {
  const texts: string[] = []
  const signals: AbortSignal[] = []
  const sampleRate = opts.sampleRate ?? 24_000
  return {
    id: 'fake-tts',
    texts,
    signals,
    async *stream(text, _opts, signal): AsyncIterable<AudioChunk> {
      if (typeof text !== 'string') throw new Error('fake tts takes strings only')
      texts.push(text)
      signals.push(signal)
      if (opts.failOn !== undefined && text.includes(opts.failOn))
        throw new ProviderError('unavailable', 'boom')
      const n = opts.chunksPerText ?? 2
      for (let c = 0; c < n; c++) {
        if (c > 0 && opts.holdText === texts.length) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
        }
        if (signal.aborted) throw new ProviderError('aborted')
        const samples = new Int16Array(opts.samplesPerChunk ?? 240).fill(texts.length * 10 + c)
        yield { data: pcm16ToBytes(samples), codec: 'pcm16', sampleRate }
      }
    },
  }
}

export type InputCall = {
  threadId: ThreadId
  personId: PersonId
  nodeId: NodeId
  modality: Modality
  text: string
}
export type ActivityCall = { threadId: ThreadId; nodeId: NodeId; speaking: boolean }
export type Sent = { nodeId: NodeId; frame: CoreFrame } | { nodeId: NodeId; bytes: Uint8Array }

export function voiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    vad: 'fake-vad',
    stt: 'fake-stt',
    tts: 'fake-tts',
    maxUtteranceMs: 30_000,
    bargeIn: true,
    bargeInMinMs: 0,
    ...overrides,
  }
}

export function createHarness(
  opts: {
    config?: VoiceConfig | undefined
    vad?: VadProvider
    stt?: SttProvider
    tts?: TtsProvider
    capabilities?: Record<string, string[]>
  } = {},
) {
  const inputs: InputCall[] = []
  const activity: ActivityCall[] = []
  const sent: Sent[] = []
  const log = createMemoryLogger()
  const deps: VoiceDeps = {
    providers: {
      vad: { list: () => (opts.vad ? [opts.vad] : []) },
      stt: { list: () => (opts.stt ? [opts.stt] : []) },
      tts: { list: () => (opts.tts ? [opts.tts] : []) },
    },
    config: 'config' in opts ? opts.config : voiceConfig(),
    threads: {
      async input(a) {
        inputs.push(a)
      },
      voiceActivity(a) {
        activity.push(a)
      },
    },
    nodes: {
      send(nodeId, frame) {
        sent.push({ nodeId, frame })
      },
      sendBinary(nodeId, bytes) {
        sent.push({ nodeId, bytes })
      },
    },
    capabilities: (n) => opts.capabilities?.[n] ?? [],
    ids: createFakeIds(),
    clock: createFakeClock(1_000),
    log,
  }
  return { deps, inputs, activity, sent, log }
}

/** `ms` of PCM16 at `rate`, every sample `value`. */
export function tone(ms: number, value: number, rate = 16_000): Uint8Array {
  return pcm16ToBytes(new Int16Array(Math.round((ms * rate) / 1000)).fill(value))
}

/** Lets queued STT and TTS work run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
