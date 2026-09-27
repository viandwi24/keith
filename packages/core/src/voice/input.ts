// Audio in: per node stream, PCM16 -> VadStream -> utterance buffer -> STT -> ThreadManager.input.
// See docs/architecture/voice.md#pipeline-voice.

import { AUDIO_SAMPLE_RATE, type AudioStreamId } from '@keith/protocol'
import type { SttProvider, VadStream } from '@keith/sdk'
import type { VoiceConfig } from '../config/types.ts'
import type { NodeId, PersonId, ThreadId } from '../shared/types.ts'
import { findProvider, type VoiceDeps } from './deps.ts'
import {
  concatPcm,
  PIPELINE_SAMPLE_RATE,
  pcm16FromBytes,
  pcm16ToBytes,
  resampleLinear,
  samplesToMs,
} from './pcm.ts'
import type { VoiceInput, VoiceStartResult } from './types.ts'

/** Audio kept from before `speech.start`, so the first syllable is not cut off. */
export const PREROLL_MS = 300

type Stream = {
  nodeId: NodeId
  personId: PersonId
  threadId: ThreadId
  streamId: AudioStreamId
  sampleRate: number
  nextSequence: number
  vad: VadStream
  stt: SttProvider
  /** Not in speech: the last PREROLL_MS of audio. */
  preroll: Int16Array[]
  prerollSamples: number
  /** In speech: the utterance so far. */
  inSpeech: boolean
  utterance: Int16Array[]
  utteranceSamples: number
  /** Samples since `speech.start`, for `bargeInMinMs`. */
  speechSamples: number
  /** `voiceActivity({ speaking: true })` was sent for the current speech. */
  activitySent: boolean
  /** Ended utterances that had sent `speaking: true` and wait for STT. */
  inflightActive: number
  /** STT runs one at a time per stream, so inputs keep their order. */
  queue: Promise<void>
  abort: AbortController
}

const refuse = (message: string): VoiceStartResult => ({ ok: false, code: 'INVALID_FRAME', message })

export function createVoiceInput(deps: VoiceDeps): VoiceInput {
  const log = deps.log.child({ component: 'voice.input' })
  const streams = new Map<string, Stream>()
  const key = (nodeId: NodeId, streamId: AudioStreamId) => `${nodeId}:${streamId}`
  const msToSamples = (ms: number) => Math.round((ms * PIPELINE_SAMPLE_RATE) / 1000)

  function activity(s: Stream, speaking: boolean): void {
    if (s.activitySent === speaking) return
    s.activitySent = speaking
    deps.threads.voiceActivity({ threadId: s.threadId, nodeId: s.nodeId, speaking })
  }

  async function transcribe(s: Stream, pcm: Int16Array, config: VoiceConfig): Promise<string> {
    const audio = { data: pcm16ToBytes(pcm), codec: 'pcm16' as const, sampleRate: PIPELINE_SAMPLE_RATE }
    const opts = { language: config.language }
    const signal = s.abort.signal
    if (s.stt.transcribe) return (await s.stt.transcribe(audio, opts, signal)).text
    if (!s.stt.stream) throw new Error(`stt provider ${s.stt.id} implements neither transcribe nor stream`)
    const stream = s.stt.stream(opts, signal)
    stream.push(audio)
    stream.end()
    const finals: string[] = []
    for await (const e of stream.events()) if (e.type === 'final') finals.push(e.text)
    return finals.join(' ')
  }

  /**
   * Sends the buffered utterance to STT. `ended`: the speech is over (VAD end, `audio.end`), so an
   * empty transcript returns the thread to idle. False for a `maxUtteranceMs` cut mid-speech: the
   * activity stays on (a new `speaking: true` after the input would read as a barge-in).
   */
  function flushUtterance(s: Stream, config: VoiceConfig, reason: string, ended: boolean): void {
    const pcm = concatPcm(s.utterance)
    s.utterance = []
    s.utteranceSamples = 0
    // Decided now, not when STT returns: new speech may start on the stream meanwhile.
    const wasActive = ended && s.activitySent
    if (ended) s.activitySent = false
    if (pcm.length === 0) {
      if (wasActive) deps.threads.voiceActivity({ threadId: s.threadId, nodeId: s.nodeId, speaking: false })
      return
    }
    if (wasActive) s.inflightActive += 1
    s.queue = s.queue.then(async () => {
      try {
        await runStt(s, pcm, config, reason, wasActive)
      } finally {
        if (wasActive) s.inflightActive -= 1
      }
    })
  }

  async function runStt(
    s: Stream,
    pcm: Int16Array,
    config: VoiceConfig,
    reason: string,
    wasActive: boolean,
  ): Promise<void> {
    if (s.abort.signal.aborted) return
    let text = ''
    try {
      text = (await transcribe(s, pcm, config)).trim()
    } catch (error) {
      if (!s.abort.signal.aborted) log.error('stt failed', { streamId: s.streamId, error })
    }
    if (s.abort.signal.aborted) return
    log.debug('utterance transcribed', {
      streamId: s.streamId,
      reason,
      ms: Math.round(samplesToMs(pcm.length, PIPELINE_SAMPLE_RATE)),
      chars: text.length,
    })
    if (text.length === 0) {
      // Back to idle, unless the person already started speaking again.
      if (wasActive && !s.activitySent) {
        deps.threads.voiceActivity({ threadId: s.threadId, nodeId: s.nodeId, speaking: false })
      }
      return
    }
    try {
      await deps.threads.input({
        threadId: s.threadId,
        personId: s.personId,
        nodeId: s.nodeId,
        modality: 'audio',
        text,
      })
    } catch (error) {
      log.error('voice input failed', { streamId: s.streamId, error })
    }
  }

  function onAudio(s: Stream, config: VoiceConfig, pcm: Int16Array): void {
    let events: ReturnType<VadStream['push']> = []
    try {
      events = s.vad.push(pcm)
    } catch (error) {
      log.error('vad failed', { streamId: s.streamId, error })
    }
    let appended = false
    const append = () => {
      if (appended) return
      appended = true
      s.utterance.push(pcm)
      s.utteranceSamples += pcm.length
      s.speechSamples += pcm.length
    }
    for (const e of events) {
      if (e.type === 'speech.start' && !s.inSpeech) {
        s.inSpeech = true
        s.utterance = s.preroll
        s.utteranceSamples = s.prerollSamples
        s.preroll = []
        s.prerollSamples = 0
        s.speechSamples = 0
        append()
      } else if (e.type === 'speech.end' && s.inSpeech) {
        append()
        s.inSpeech = false
        flushUtterance(s, config, 'speech.end', true)
      }
    }
    if (s.inSpeech) {
      append()
      if (s.speechSamples >= msToSamples(config.bargeInMinMs)) activity(s, true)
      if (s.utteranceSamples >= msToSamples(config.maxUtteranceMs)) {
        flushUtterance(s, config, 'maxUtteranceMs', false)
      }
    } else if (!appended) {
      s.preroll.push(pcm)
      s.prerollSamples += pcm.length
      const keep = msToSamples(PREROLL_MS)
      while (s.preroll.length > 1 && s.prerollSamples - (s.preroll[0]?.length ?? 0) >= keep) {
        s.prerollSamples -= s.preroll.shift()?.length ?? 0
      }
    }
  }

  function close(s: Stream): void {
    streams.delete(key(s.nodeId, s.streamId))
    try {
      s.vad.close()
    } catch (error) {
      log.debug('vad close failed', { streamId: s.streamId, error })
    }
  }

  return {
    start(a) {
      const config = deps.config
      if (!config) {
        log.warn('audio stream refused: voice is not configured', { nodeId: a.nodeId })
        return refuse('voice is not configured')
      }
      if (a.codec !== 'pcm16') return refuse(`codec ${a.codec} is not supported (v1: pcm16)`)
      if (
        !Number.isInteger(a.sampleRate) ||
        a.sampleRate < AUDIO_SAMPLE_RATE.min ||
        a.sampleRate > AUDIO_SAMPLE_RATE.max
      ) {
        return refuse(`sample rate ${a.sampleRate} is not supported`)
      }
      if (streams.has(key(a.nodeId, a.streamId))) return refuse(`stream ${a.streamId} is already open`)
      const vadProvider = findProvider(deps.providers.vad, config.vad)
      const stt = findProvider(deps.providers.stt, config.stt)
      if (!vadProvider || !stt) {
        const missing = !vadProvider ? `vad provider ${config.vad}` : `stt provider ${config.stt}`
        log.warn('audio stream refused: provider not registered', { nodeId: a.nodeId, missing })
        return refuse(`${missing} is not registered`)
      }
      let vad: VadStream
      try {
        vad = vadProvider.create({ sampleRate: PIPELINE_SAMPLE_RATE })
      } catch (error) {
        log.error('vad create failed', { nodeId: a.nodeId, error })
        return refuse('voice activity detection is unavailable')
      }
      streams.set(key(a.nodeId, a.streamId), {
        nodeId: a.nodeId,
        personId: a.personId,
        threadId: a.threadId,
        streamId: a.streamId,
        sampleRate: a.sampleRate,
        nextSequence: 0,
        vad,
        stt,
        preroll: [],
        prerollSamples: 0,
        inSpeech: false,
        utterance: [],
        utteranceSamples: 0,
        speechSamples: 0,
        activitySent: false,
        inflightActive: 0,
        queue: Promise.resolve(),
        abort: new AbortController(),
      })
      log.debug('audio stream started', { nodeId: a.nodeId, streamId: a.streamId, sampleRate: a.sampleRate })
      return { ok: true }
    },

    chunk(a) {
      const s = streams.get(key(a.nodeId, a.streamId))
      if (!s) {
        log.debug('audio chunk for an unknown stream dropped', { nodeId: a.nodeId, streamId: a.streamId })
        return false
      }
      const config = deps.config
      if (!config) return false
      if (a.sequence < s.nextSequence) {
        log.debug('out-of-order audio chunk dropped', {
          streamId: a.streamId,
          sequence: a.sequence,
          expected: s.nextSequence,
        })
        return true
      }
      if (a.sequence > s.nextSequence) {
        log.debug('audio chunks missing', { streamId: a.streamId, from: s.nextSequence, to: a.sequence - 1 })
      }
      s.nextSequence = a.sequence + 1
      if (a.payload.byteLength % 2 !== 0) {
        log.debug('odd audio payload: trailing byte dropped', { streamId: a.streamId, sequence: a.sequence })
      }
      const pcm = resampleLinear(pcm16FromBytes(a.payload), s.sampleRate, PIPELINE_SAMPLE_RATE)
      if (pcm.length > 0) onAudio(s, config, pcm)
      return true
    },

    end(a) {
      const s = streams.get(key(a.nodeId, a.streamId))
      if (!s) return false
      close(s)
      const config = deps.config
      if (config && s.inSpeech) {
        s.inSpeech = false
        flushUtterance(s, config, 'audio.end', true)
      } else {
        activity(s, false)
      }
      return true
    },

    detach(nodeId) {
      for (const s of [...streams.values()]) {
        if (s.nodeId !== nodeId) continue
        close(s)
        s.abort.abort()
        if (s.activitySent || s.inflightActive > 0) {
          s.activitySent = false
          deps.threads.voiceActivity({ threadId: s.threadId, nodeId: s.nodeId, speaking: false })
        }
      }
    },
  }
}
