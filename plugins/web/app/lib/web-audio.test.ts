import { describe, expect, test } from 'bun:test'
import { type AudioEvent, createPlaybackQueue, pcm16ToBytes } from '@keith/client'
import { createAudioOutput, type PlaybackContext } from './web-audio.ts'

const STREAM = '01J8ZQ3K4M5N6P7Q8R9S0T1V51'

type FakeSource = {
  buffer: { data: Float32Array; sampleRate: number } | null
  startedAt: number | null
  stopped: boolean
  connected: boolean
  onended: (() => void) | null
}

/** Enough of an `AudioContext` for playback, recording every source node. */
function fakeContext(initialState: AudioContextState = 'running') {
  const sources: FakeSource[] = []
  const ctx = {
    currentTime: 0,
    state: initialState,
    destination: {},
    resumed: 0,
    closed: false,
    createBuffer(_channels: number, length: number, sampleRate: number) {
      const data = new Float32Array(length)
      return { data, sampleRate, getChannelData: () => data }
    },
    createBufferSource() {
      const source: FakeSource & Record<string, unknown> = {
        buffer: null,
        startedAt: null,
        stopped: false,
        connected: false,
        onended: null,
        connect() {
          source.connected = true
        },
        disconnect() {
          source.connected = false
        },
        start(at: number) {
          source.startedAt = at
        },
        stop() {
          source.stopped = true
        },
      }
      sources.push(source)
      return source
    },
    async resume() {
      ctx.resumed += 1
      ctx.state = 'running'
    },
    async close() {
      ctx.closed = true
    },
  }
  return { ctx, sources, context: ctx as unknown as PlaybackContext }
}

function chunk(sequence: number, value: number, samples = 2400): AudioEvent {
  return {
    type: 'chunk',
    streamId: STREAM,
    sequence,
    payload: pcm16ToBytes(new Int16Array(samples).fill(value)),
  }
}

const start: AudioEvent = {
  type: 'start',
  threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
  messageId: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V43',
  streamId: STREAM,
  codec: 'pcm16',
  sampleRate: 24_000,
}

describe('Web Audio playback', () => {
  test('plays chunks in sequence order, back to back, at the announced rate', () => {
    const fake = fakeContext()
    const output = createAudioOutput(() => fake.context)
    const playing: boolean[] = []
    const queue = createPlaybackQueue({ sink: output.sink, onPlayingChange: (p) => playing.push(p) })
    fake.ctx.currentTime = 2
    queue.handle(start)
    queue.handle(chunk(1, 16384))
    expect(fake.sources).toHaveLength(0)
    queue.handle(chunk(0, -16384))
    queue.handle(chunk(2, 8192))

    expect(fake.sources.map((s) => s.buffer?.data[0])).toEqual([-0.5, 0.5, 0.25])
    expect(fake.sources.map((s) => s.buffer?.sampleRate)).toEqual([24_000, 24_000, 24_000])
    // 2400 samples at 24 kHz = 100 ms each, after a 50 ms lead.
    expect(fake.sources.map((s) => Number(s.startedAt?.toFixed(3)))).toEqual([2.05, 2.15, 2.25])
    expect(fake.sources.every((s) => s.connected)).toBe(true)
    expect(playing).toEqual([true])

    for (const s of fake.sources) s.onended?.()
    expect(playing).toEqual([true, false])
    expect(fake.sources.every((s) => !s.connected)).toBe(true)
  })

  test('audio.stop cuts every scheduled source at once', () => {
    const fake = fakeContext()
    const queue = createPlaybackQueue({ sink: createAudioOutput(() => fake.context).sink })
    queue.handle(start)
    queue.handle(chunk(0, 1))
    queue.handle(chunk(1, 2))
    queue.handle({ type: 'stop', streamId: STREAM })
    expect(fake.sources.map((s) => [s.stopped, s.connected])).toEqual([
      [true, false],
      [true, false],
    ])
    expect(queue.playing).toBe(false)
    // A stopped source's `ended` event no longer reaches the queue.
    expect(fake.sources[0]?.onended).toBeNull()
  })

  test('the context is created on first use and resumed when the autoplay policy suspended it', async () => {
    const fake = fakeContext('suspended')
    let created = 0
    const output = createAudioOutput(() => {
      created += 1
      return fake.context
    })
    expect(created).toBe(0)
    await output.resume()
    expect(created).toBe(1)
    expect(fake.ctx.resumed).toBe(1)
    await output.close()
    expect(fake.ctx.closed).toBe(true)
  })
})
