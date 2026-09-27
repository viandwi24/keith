// Speech out: assistant text deltas -> sentences -> TTS -> `audio.start`, kind-2 binary frames,
// `audio.end` to one node. See docs/architecture/voice.md#pipeline-voice.

import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_KIND,
  AUDIO_FRAME_MAX_BYTES,
  AUDIO_SAMPLE_RATE,
  type AudioStreamId,
  encodeAudioFrame,
  makeCoreFrame,
} from '@keith/protocol'
import { ProviderError, type TtsProvider } from '@keith/sdk'
import type { VoiceConfig } from '../config/types.ts'
import type { MessageId, NodeId, ThreadId } from '../shared/types.ts'
import { bareUlid, findProvider, type VoiceDeps } from './deps.ts'
import { pcm16FromBytes, pcm16ToBytes, resampleLinear } from './pcm.ts'
import { createSentenceSplitter } from './sentences.ts'
import type { SpeechHandle, VoiceOutput } from './types.ts'

export const AUDIO_OUT_CAPABILITY = 'audio.out@1'

/** Largest payload per binary frame, rounded down to whole samples. */
const MAX_PAYLOAD_BYTES = (AUDIO_FRAME_MAX_BYTES - AUDIO_FRAME_HEADER_BYTES) & ~1

export function createVoiceOutput(deps: VoiceDeps): VoiceOutput {
  const log = deps.log.child({ component: 'voice.output' })
  return {
    begin(a) {
      const config = deps.config
      if (!config) return null
      if (!deps.capabilities(a.nodeId).includes(AUDIO_OUT_CAPABILITY)) return null
      const tts = findProvider(deps.providers.tts, config.tts)
      if (!tts) {
        log.warn('reply not spoken: tts provider not registered', { tts: config.tts })
        return null
      }
      return createSpeech(deps, config, tts, a, log)
    },
  }
}

function createSpeech(
  deps: VoiceDeps,
  config: VoiceConfig,
  tts: TtsProvider,
  a: { threadId: ThreadId; nodeId: NodeId; messageId: MessageId },
  log: VoiceDeps['log'],
): SpeechHandle {
  const splitter = createSentenceSplitter()
  const abort = new AbortController()
  const queue: string[] = []
  const streamId: AudioStreamId = bareUlid(deps.ids)
  let spokenChars = 0
  let sequence = 0
  /** The rate announced in `audio.start`; null until the first chunk. */
  let sampleRate: number | null = null
  let ended = false
  let stopped = false
  let finished = false
  let pumping = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const frameOpts = () => ({ id: bareUlid(deps.ids), ts: deps.clock.now() })

  function finish(): void {
    if (finished) return
    finished = true
    resolveDone()
  }

  function sendAudio(bytes: Uint8Array, rate: number): void {
    if (sampleRate === null) {
      if (rate < AUDIO_SAMPLE_RATE.min || rate > AUDIO_SAMPLE_RATE.max || !Number.isInteger(rate)) {
        throw new Error(`tts sample rate ${rate} is out of range`)
      }
      sampleRate = rate
      deps.nodes.send(
        a.nodeId,
        makeCoreFrame(
          'audio.start',
          { threadId: a.threadId, messageId: a.messageId, streamId, codec: 'pcm16', sampleRate },
          frameOpts(),
        ),
      )
    }
    let payload = bytes
    if (rate !== sampleRate) payload = pcm16ToBytes(resampleLinear(pcm16FromBytes(bytes), rate, sampleRate))
    const usable = payload.byteLength & ~1
    for (let offset = 0; offset < usable; offset += MAX_PAYLOAD_BYTES) {
      const part = payload.subarray(offset, Math.min(offset + MAX_PAYLOAD_BYTES, usable))
      deps.nodes.sendBinary(
        a.nodeId,
        encodeAudioFrame({ kind: AUDIO_FRAME_KIND.out, streamId, sequence, payload: part }),
      )
      sequence += 1
    }
  }

  async function speak(piece: string): Promise<void> {
    const text = piece.trim()
    if (text.length > 0) {
      for await (const chunk of tts.stream(text, { language: config.language }, abort.signal)) {
        if (stopped) return
        if (chunk.codec !== 'pcm16') throw new Error(`tts codec ${chunk.codec} is not supported (v1: pcm16)`)
        sendAudio(chunk.data, chunk.sampleRate)
      }
    }
    if (stopped) return
    spokenChars += piece.length
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (!stopped && queue.length > 0) {
        const piece = queue.shift() ?? ''
        await speak(piece)
      }
    } catch (error) {
      if (!stopped) {
        const aborted = error instanceof ProviderError && error.code === 'aborted'
        if (!aborted) log.error('tts failed: speech ended early', { streamId, error })
        // Nothing more is spoken; the node plays what it has.
        queue.length = 0
        ended = true
      }
    } finally {
      pumping = false
    }
    if (stopped) return
    if (ended && queue.length === 0) {
      if (sampleRate !== null)
        deps.nodes.send(a.nodeId, makeCoreFrame('audio.end', { streamId }, frameOpts()))
      finish()
    }
  }

  const run = () => {
    void pump()
  }

  return {
    push(text) {
      if (ended || stopped || text.length === 0) return
      const pieces = splitter.push(text)
      if (pieces.length === 0) return
      queue.push(...pieces)
      run()
    },
    end() {
      if (ended || stopped) return
      ended = true
      queue.push(...splitter.flush())
      run()
    },
    stop() {
      if (stopped || finished) return spokenChars
      stopped = true
      queue.length = 0
      abort.abort()
      if (sampleRate !== null)
        deps.nodes.send(a.nodeId, makeCoreFrame('audio.stop', { streamId }, frameOpts()))
      finish()
      return spokenChars
    },
    done,
  }
}
