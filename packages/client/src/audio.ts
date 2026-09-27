import type { AudioCodec, AudioStreamId, MessageId, ThreadId } from '@keith/protocol'

/**
 * Voice on a node (phase 3, ADR-0013): the audio events a `ChatClient` surfaces, PCM16 helpers,
 * stream ids, and a platform-free playback queue. The node only captures and plays raw audio;
 * VAD, STT and TTS run in the core (docs/architecture/voice.md). No Web Audio here: the embedding
 * app gives the queue a `PlaybackSink` (the web app wraps an `AudioContext`).
 */

/** v1 nodes send PCM16LE mono at 16 kHz. */
export const AUDIO_IN_SAMPLE_RATE = 16_000
/** v1 nodes send 20 ms chunks. */
export const AUDIO_IN_CHUNK_MS = 20
/** Samples in one 20 ms chunk at 16 kHz (320, i.e. 640 bytes). */
export const AUDIO_IN_CHUNK_SAMPLES = (AUDIO_IN_SAMPLE_RATE * AUDIO_IN_CHUNK_MS) / 1000

/** Audio from the core, as `ChatClientDeps.onAudio` reports it. */
export type AudioEvent =
  /** The core starts speaking `messageId` on this node (`audio.start`, core → node). */
  | {
      type: 'start'
      threadId: ThreadId
      messageId: MessageId
      streamId: AudioStreamId
      codec: AudioCodec
      sampleRate: number
    }
  /** One kind-2 binary frame: `payload` holds PCM16LE samples in v1. */
  | { type: 'chunk'; streamId: AudioStreamId; sequence: number; payload: Uint8Array }
  /** The core finished sending the stream (`audio.end`): play what is queued, then stop. */
  | { type: 'end'; streamId: AudioStreamId }
  /** Barge-in or cancel (`audio.stop`): stop now and drop what is queued of the stream. */
  | { type: 'stop'; streamId: AudioStreamId }
  /** This node sent a new user input: stop all playback. */
  | { type: 'flush'; reason: 'input' }

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A bare ULID for a new audio stream (the sender of `audio.start` generates it; the binary header
 * carries its 16 raw bytes). 48-bit millisecond time, then 80 random bits.
 */
export function newStreamId(
  now: () => number = Date.now,
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): AudioStreamId {
  let time = Math.max(0, Math.floor(now()))
  let head = ''
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head
    time = Math.floor(time / 32)
  }
  let value = 0n
  for (const byte of randomBytes(10)) value = (value << 8n) | BigInt(byte)
  let tail = ''
  for (let i = 0; i < 16; i++) {
    tail = CROCKFORD.charAt(Number(value & 31n)) + tail
    value >>= 5n
  }
  return head + tail
}

/** PCM16 samples → little-endian bytes (the wire order, whatever the platform's). */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true)
  return bytes
}

/** Little-endian PCM16 bytes → samples. A trailing odd byte is ignored. */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const count = bytes.byteLength >> 1
  const samples = new Int16Array(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true)
  return samples
}

/** PCM16 samples → floats in [-1, 1), for an audio API. */
export function pcm16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) / 0x8000
  return out
}

/** Something that plays PCM on a clock: the web app wraps an `AudioContext`. */
export type PlaybackSink = {
  /** The audio clock, in seconds. */
  now(): number
  /**
   * Plays `samples` at `sampleRate` starting at clock time `at`. `onEnded` runs when it finished
   * playing (not after `stop()`).
   */
  play(samples: Float32Array, sampleRate: number, at: number, onEnded: () => void): { stop(): void }
}

export type PlaybackQueueOptions = {
  sink: PlaybackSink
  /** Delay before the first chunk plays when nothing is playing, in seconds. Default 0.05. */
  leadSeconds?: number | undefined
  /** Out-of-order chunks kept per stream while an earlier one is missing. Default 64. */
  maxPendingChunks?: number | undefined
  /** Called when playback starts or stops (a speaking indicator). */
  onPlayingChange?: ((playing: boolean) => void) | undefined
}

export type PlaybackQueue = {
  /** Feeds one event from `ChatClientDeps.onAudio`. */
  handle(event: AudioEvent): void
  /** Stops everything now and drops what is queued. Late chunks of those streams are ignored. */
  stop(): void
  /** Something is playing or scheduled. */
  readonly playing: boolean
  /** Chunks handed to the sink that have not finished. */
  readonly scheduled: number
  /** Chunks held back until an earlier sequence arrives. */
  readonly pending: number
}

type StreamState = {
  codec: AudioCodec
  sampleRate: number
  nextSequence: number
  /** Chunks that arrived ahead of `nextSequence`, by sequence. */
  pending: Map<number, Uint8Array>
}

type Scheduled = { streamId: AudioStreamId; handle: { stop(): void } }

/** Streams remembered as stopped, so their late chunks are dropped. */
const STOPPED_MEMORY = 32

/**
 * Plays the core's audio streams in order, gaplessly, on a `PlaybackSink`. Chunks are played by
 * `sequence` (a missing one holds the later ones back until it arrives, the stream ends, or too
 * many are waiting). `audio.stop`, a `flush` or `stop()` stop at once and drop the queue. Only
 * `pcm16` is played; other codecs are ignored (Opus is a follow-up, ADR-0013).
 */
export function createPlaybackQueue(opts: PlaybackQueueOptions): PlaybackQueue {
  const { sink } = opts
  const lead = opts.leadSeconds ?? 0.05
  const maxPending = opts.maxPendingChunks ?? 64
  const streams = new Map<AudioStreamId, StreamState>()
  const stopped: AudioStreamId[] = []
  const scheduled = new Set<Scheduled>()
  let nextTime = 0
  let playing = false

  const setPlaying = (next: boolean) => {
    if (next === playing) return
    playing = next
    opts.onPlayingChange?.(next)
  }

  const schedule = (streamId: AudioStreamId, stream: StreamState, payload: Uint8Array) => {
    const samples = pcm16FromBytes(payload)
    if (samples.length === 0) return
    const at = Math.max(nextTime, sink.now() + lead)
    nextTime = at + samples.length / stream.sampleRate
    const entry: Scheduled = {
      streamId,
      handle: sink.play(pcm16ToFloat32(samples), stream.sampleRate, at, () => {
        scheduled.delete(entry)
        if (scheduled.size === 0) setPlaying(false)
      }),
    }
    scheduled.add(entry)
    setPlaying(true)
  }

  const drain = (streamId: AudioStreamId, stream: StreamState) => {
    for (let payload = stream.pending.get(stream.nextSequence); payload; ) {
      stream.pending.delete(stream.nextSequence)
      stream.nextSequence += 1
      schedule(streamId, stream, payload)
      payload = stream.pending.get(stream.nextSequence)
    }
  }

  /** Gives up on missing chunks: plays what is held, in order. */
  const skipGaps = (streamId: AudioStreamId, stream: StreamState) => {
    const sequences = [...stream.pending.keys()].sort((a, b) => a - b)
    for (const sequence of sequences) {
      const payload = stream.pending.get(sequence)
      stream.pending.delete(sequence)
      stream.nextSequence = sequence + 1
      if (payload) schedule(streamId, stream, payload)
    }
  }

  const rememberStopped = (streamId: AudioStreamId) => {
    stopped.push(streamId)
    if (stopped.length > STOPPED_MEMORY) stopped.shift()
  }

  const stopScheduled = (match: (entry: Scheduled) => boolean) => {
    for (const entry of [...scheduled]) {
      if (!match(entry)) continue
      scheduled.delete(entry)
      entry.handle.stop()
    }
    if (scheduled.size === 0) {
      nextTime = 0
      setPlaying(false)
    }
  }

  const stopAll = () => {
    for (const streamId of streams.keys()) rememberStopped(streamId)
    streams.clear()
    stopScheduled(() => true)
  }

  return {
    handle(event) {
      switch (event.type) {
        case 'start':
          if (stopped.includes(event.streamId)) return
          streams.set(event.streamId, {
            codec: event.codec,
            sampleRate: event.sampleRate,
            nextSequence: 0,
            pending: new Map(),
          })
          return
        case 'chunk': {
          const stream = streams.get(event.streamId)
          if (stream?.codec !== 'pcm16' || event.sequence < stream.nextSequence) return
          stream.pending.set(event.sequence, event.payload)
          drain(event.streamId, stream)
          if (stream.pending.size > maxPending) skipGaps(event.streamId, stream)
          return
        }
        case 'end': {
          const stream = streams.get(event.streamId)
          if (!stream) return
          skipGaps(event.streamId, stream)
          streams.delete(event.streamId)
          return
        }
        case 'stop':
          rememberStopped(event.streamId)
          streams.delete(event.streamId)
          stopScheduled((entry) => entry.streamId === event.streamId)
          return
        case 'flush':
          stopAll()
          return
      }
    },
    stop: stopAll,
    get playing() {
      return playing
    },
    get scheduled() {
      return scheduled.size
    },
    get pending() {
      let count = 0
      for (const stream of streams.values()) count += stream.pending.size
      return count
    },
  }
}
