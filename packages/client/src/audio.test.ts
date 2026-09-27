import { describe, expect, test } from 'bun:test'
import { ULID_PATTERN } from '@keith/protocol'
import {
  AUDIO_IN_CHUNK_SAMPLES,
  type AudioEvent,
  createPlaybackQueue,
  newStreamId,
  type PlaybackSink,
  pcm16FromBytes,
  pcm16ToBytes,
  pcm16ToFloat32,
} from './audio.ts'

const STREAM = '01J8ZQ3K4M5N6P7Q8R9S0T1V51'
const OTHER = '01J8ZQ3K4M5N6P7Q8R9S0T1V52'
const THREAD = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31'
const MESSAGE = 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V43'

type Played = { first: number; length: number; sampleRate: number; at: number; stopped: boolean }

/** A sink on a manual clock that records what was scheduled. */
function fakeSink() {
  let time = 0
  const played: Played[] = []
  const ends: (() => void)[] = []
  const sink: PlaybackSink = {
    now: () => time,
    play(samples, sampleRate, at, onEnded) {
      const entry: Played = {
        first: Math.round((samples[0] ?? 0) * 0x8000),
        length: samples.length,
        sampleRate,
        at,
        stopped: false,
      }
      played.push(entry)
      ends.push(onEnded)
      return {
        stop() {
          entry.stopped = true
        },
      }
    },
  }
  return {
    sink,
    played,
    setTime: (t: number) => {
      time = t
    },
    /** Ends every chunk played so far. */
    endAll: () => {
      for (const end of ends.splice(0)) end()
    },
  }
}

/** A chunk whose samples all equal `value` (so the played order is readable). */
function chunk(value: number, samples = 240): Uint8Array {
  return pcm16ToBytes(new Int16Array(samples).fill(value))
}

const start = (streamId = STREAM, sampleRate = 24_000, codec: 'pcm16' | 'opus' = 'pcm16'): AudioEvent => ({
  type: 'start',
  threadId: THREAD,
  messageId: MESSAGE,
  streamId,
  codec,
  sampleRate,
})

const chunkEvent = (sequence: number, streamId = STREAM): AudioEvent => ({
  type: 'chunk',
  streamId,
  sequence,
  payload: chunk(sequence + 1),
})

describe('PCM16 helpers', () => {
  test('bytes are little-endian and round-trip', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 258])
    const bytes = pcm16ToBytes(samples)
    expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, 0xff, 0xff])
    expect([...bytes.subarray(10, 12)]).toEqual([0x02, 0x01])
    expect([...pcm16FromBytes(bytes)]).toEqual([...samples])
    // A view at an odd offset works too.
    const shifted = new Uint8Array(bytes.length + 1)
    shifted.set(bytes, 1)
    expect([...pcm16FromBytes(shifted.subarray(1))]).toEqual([...samples])
  })

  test('floats span [-1, 1)', () => {
    expect([...pcm16ToFloat32(Int16Array.from([0, -32768, 16384]))]).toEqual([0, -1, 0.5])
  })

  test('a 20 ms chunk at 16 kHz is 320 samples', () => {
    expect(AUDIO_IN_CHUNK_SAMPLES).toBe(320)
  })

  test('stream ids are bare ULIDs with the time first', () => {
    const id = newStreamId(
      () => 1_790_000_000_000,
      (n) => new Uint8Array(n).fill(0xff),
    )
    expect(id).toMatch(ULID_PATTERN)
    expect(id.endsWith('ZZZZZZZZZZZZZZZZ')).toBe(true)
    expect(newStreamId()).not.toBe(newStreamId())
  })
})

describe('playback queue', () => {
  test('schedules chunks gaplessly in sequence order, holding one that arrives early', () => {
    const fake = fakeSink()
    const playing: boolean[] = []
    const queue = createPlaybackQueue({
      sink: fake.sink,
      leadSeconds: 0.05,
      onPlayingChange: (p) => playing.push(p),
    })
    queue.handle(start())
    queue.handle(chunkEvent(0))
    queue.handle(chunkEvent(2))
    expect(queue.pending).toBe(1)
    queue.handle(chunkEvent(1))
    queue.handle(chunkEvent(1)) // a duplicate is dropped
    expect(queue.pending).toBe(0)
    expect(fake.played.map((p) => p.first)).toEqual([1, 2, 3])
    // 240 samples at 24 kHz = 10 ms each, back to back after the lead.
    expect(fake.played.map((p) => Number(p.at.toFixed(3)))).toEqual([0.05, 0.06, 0.07])
    expect(queue.playing).toBe(true)
    fake.endAll()
    expect(queue.playing).toBe(false)
    expect(playing).toEqual([true, false])
  })

  test('audio.end plays what is held, skipping a missing chunk', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink })
    queue.handle(start())
    queue.handle(chunkEvent(0))
    queue.handle(chunkEvent(3))
    queue.handle(chunkEvent(2))
    expect(fake.played.map((p) => p.first)).toEqual([1])
    queue.handle({ type: 'end', streamId: STREAM })
    expect(fake.played.map((p) => p.first)).toEqual([1, 3, 4])
    expect(queue.pending).toBe(0)
  })

  test('audio.stop stops what plays, drops the queue and ignores late chunks', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink })
    queue.handle(start())
    queue.handle(chunkEvent(0))
    queue.handle(chunkEvent(1))
    queue.handle(chunkEvent(3))
    expect(queue.scheduled).toBe(2)
    queue.handle({ type: 'stop', streamId: STREAM })
    expect(fake.played.every((p) => p.stopped)).toBe(true)
    expect(queue.scheduled).toBe(0)
    expect(queue.pending).toBe(0)
    expect(queue.playing).toBe(false)
    queue.handle(chunkEvent(2))
    queue.handle(start())
    queue.handle(chunkEvent(4))
    expect(fake.played).toHaveLength(2)
  })

  test('a new stream after a stop starts fresh at the lead time', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink, leadSeconds: 0.1 })
    queue.handle(start())
    queue.handle(chunkEvent(0))
    queue.handle(chunkEvent(1))
    fake.setTime(1)
    queue.handle({ type: 'flush', reason: 'input' })
    queue.handle(start(OTHER, 16_000))
    queue.handle(chunkEvent(0, OTHER))
    const last = fake.played.at(-1)
    expect(last?.at).toBeCloseTo(1.1)
    expect(last?.sampleRate).toBe(16_000)
  })

  test('streams queue one after the other', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink, leadSeconds: 0 })
    queue.handle(start())
    queue.handle(chunkEvent(0))
    queue.handle(start(OTHER))
    queue.handle(chunkEvent(0, OTHER))
    expect(fake.played.map((p) => Number(p.at.toFixed(3)))).toEqual([0, 0.01])
    queue.handle({ type: 'stop', streamId: STREAM })
    // Only the stopped stream's chunk is cut.
    expect(fake.played.map((p) => p.stopped)).toEqual([true, false])
    expect(queue.playing).toBe(true)
  })

  test('ignores chunks without a start, and codecs other than pcm16', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink })
    queue.handle(chunkEvent(0))
    queue.handle(start(STREAM, 24_000, 'opus'))
    queue.handle(chunkEvent(0))
    expect(fake.played).toHaveLength(0)
  })

  test('gives up on a missing chunk when too many wait behind it', () => {
    const fake = fakeSink()
    const queue = createPlaybackQueue({ sink: fake.sink, maxPendingChunks: 2 })
    queue.handle(start())
    queue.handle(chunkEvent(1))
    queue.handle(chunkEvent(2))
    expect(fake.played).toHaveLength(0)
    queue.handle(chunkEvent(3))
    expect(fake.played.map((p) => p.first)).toEqual([2, 3, 4])
    queue.handle(chunkEvent(0)) // too late now
    expect(fake.played).toHaveLength(3)
  })
})
