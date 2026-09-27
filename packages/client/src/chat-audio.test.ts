import { afterEach, describe, expect, test } from 'bun:test'
import { AUDIO_FRAME_MAX_BYTES, decodeAudioFrame, encodeAudioFrame } from '@keith/protocol'
import { type FakeCoreOptions, startFakeCore } from '../test/fake-core.ts'
import { waitUntil } from '../test/wait.ts'
import { type AudioEvent, createPlaybackQueue, type PlaybackSink, pcm16FromBytes } from './audio.ts'
import { type AudioSupport, clientCapabilities, createChatClient } from './chat.ts'
import { login } from './http.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(
  opts: FakeCoreOptions & { audio?: AudioSupport; capabilities?: string[]; tui?: boolean } = {},
) {
  const core = startFakeCore(opts)
  cleanups.push(() => core.stop())
  const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
  const events: AudioEvent[] = []
  const client = createChatClient({
    baseUrl: core.url,
    token,
    client: { name: opts.tui ? 'keith-tui' : 'keith-web', version: '0.0.0' },
    onState: () => {},
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
    capabilities: opts.capabilities,
    audio: opts.audio,
    onAudio: (e) => events.push(e),
  })
  cleanups.push(() => client.close())
  client.start()
  await waitUntil(() => client.state.thread !== null, 3000, 'thread.opened')
  return { core, client, events }
}

const both: AudioSupport = { input: true, output: true }

describe('audio capabilities', () => {
  test('declared only when the embedding app says it can', async () => {
    expect(clientCapabilities(['chat.text@1'])).toEqual(['chat.text@1'])
    expect(clientCapabilities(['chat.text@1', 'audio.in@1'])).toEqual(['chat.text@1'])
    expect(clientCapabilities(['chat.text@1', 'ui.render@1'], both)).toEqual([
      'chat.text@1',
      'ui.render@1',
      'audio.in@1',
      'audio.out@1',
    ])
    expect(clientCapabilities(['chat.text@1'], { output: true })).toEqual(['chat.text@1', 'audio.out@1'])

    const web = await setup({ audio: both, capabilities: ['chat.text@1', 'ui.render@1'] })
    expect(web.core.received[0]).toMatchObject({
      type: 'hello',
      data: { capabilities: ['chat.text@1', 'ui.render@1', 'audio.in@1', 'audio.out@1'] },
    })
  })

  test('a TUI-like client never declares audio and cannot start a stream', async () => {
    const { core, client } = await setup({ tui: true, capabilities: ['chat.text@1', 'audio.out@1'] })
    expect(core.received[0]).toMatchObject({ type: 'hello', data: { capabilities: ['chat.text@1'] } })
    expect(client.startAudio()).toEqual({ ok: false, reason: 'unsupported' })
    expect(client.sendAudio('01J8ZQ3K4M5N6P7Q8R9S0T1V51', 0, new Int16Array(320))).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })
})

describe('sending audio', () => {
  test('audio.start, kind-1 binary frames that decodeAudioFrame reads back, audio.end', async () => {
    const { core, client } = await setup({ audio: both })
    const started = client.startAudio()
    if (!started.ok) throw new Error(`startAudio failed: ${started.reason}`)
    const { streamId } = started
    const chunks = [0, 1, 2].map((n) => Int16Array.from({ length: 320 }, (_, i) => (i - 160) * (n + 1)))
    for (const [sequence, pcm] of chunks.entries()) {
      expect(client.sendAudio(streamId, sequence, pcm)).toEqual({ ok: true })
    }
    expect(client.endAudio(streamId)).toBe(true)
    await waitUntil(() => core.received.some((f) => f.type === 'audio.end'), 3000, 'audio.end')

    expect(core.received.find((f) => f.type === 'audio.start')).toMatchObject({
      data: { threadId: core.thread.id, streamId, codec: 'pcm16', sampleRate: 16_000 },
    })
    expect(core.receivedAudio.map((f) => [f.kind, f.streamId, f.sequence])).toEqual([
      [1, streamId, 0],
      [1, streamId, 1],
      [1, streamId, 2],
    ])
    for (const [i, frame] of core.receivedAudio.entries()) {
      expect(frame.payload.byteLength).toBe(640)
      expect([...pcm16FromBytes(frame.payload)]).toEqual([...(chunks[i] ?? [])])
    }
    // The fake core decodes with the same function; check the raw bytes too.
    const raw = encodeAudioFrame(
      core.receivedAudio[0] ?? { kind: 1, streamId, sequence: 0, payload: new Uint8Array() },
    )
    const decoded = decodeAudioFrame(raw)
    expect(decoded.ok && decoded.frame.streamId).toBe(streamId)
    expect(client.endAudio(streamId)).toBe(false)
  })

  test('rejects an unknown stream and a chunk too big for one frame', async () => {
    const { client } = await setup({ audio: both })
    expect(client.sendAudio('01J8ZQ3K4M5N6P7Q8R9S0T1V51', 0, new Int16Array(320))).toEqual({
      ok: false,
      reason: 'unknown-stream',
    })
    const started = client.startAudio()
    if (!started.ok) throw new Error('startAudio failed')
    expect(client.sendAudio(started.streamId, 0, new Int16Array(AUDIO_FRAME_MAX_BYTES / 2))).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  test('a lost connection ends the stream; a new one can start after reconnecting', async () => {
    const { core, client } = await setup({ audio: both })
    const started = client.startAudio()
    if (!started.ok) throw new Error('startAudio failed')
    core.dropConnections()
    await waitUntil(() => client.state.connection.kind !== 'online', 3000, 'offline')
    expect(client.sendAudio(started.streamId, 0, new Int16Array(320)).ok).toBe(false)
    expect(client.startAudio()).toEqual({ ok: false, reason: 'offline' })
    await waitUntil(() => core.hellos === 2 && client.state.connection.kind === 'online', 3000, 'reconnect')
    await waitUntil(() => client.state.thread !== null, 3000, 'thread')
    expect(client.sendAudio(started.streamId, 0, new Int16Array(320))).toEqual({
      ok: false,
      reason: 'unknown-stream',
    })
    expect(client.startAudio().ok).toBe(true)
  })
})

describe('receiving audio', () => {
  test('audio.start, binary chunks and audio.end surface as typed events', async () => {
    const { core, events } = await setup({ audio: both })
    const chunks = [Int16Array.from([1, 2, 3]), Int16Array.from([-4, 5])]
    const streamId = core.pushAudio({ chunks, sampleRate: 24_000 })
    await waitUntil(() => events.some((e) => e.type === 'end'), 3000, 'audio.end')
    expect(events.map((e) => e.type)).toEqual(['start', 'chunk', 'chunk', 'end'])
    expect(events[0]).toMatchObject({ type: 'start', threadId: core.thread.id, streamId, sampleRate: 24_000 })
    const received = events.flatMap((e) =>
      e.type === 'chunk' ? [[e.sequence, [...pcm16FromBytes(e.payload)]]] : [],
    )
    expect(received).toEqual([
      [0, [1, 2, 3]],
      [1, [-4, 5]],
    ])
  })

  test('no audio reaches a client without audio.out@1', async () => {
    const { core, events } = await setup({ audio: { input: true } })
    core.pushAudio({ chunks: [Int16Array.from([1])] })
    await core.pushProactive('marker')
    expect(events).toEqual([])
  })

  test('audio.stop clears queued chunks, and a new user input flushes playback', async () => {
    const played: { stopped: boolean }[] = []
    const sink: PlaybackSink = {
      now: () => 0,
      play() {
        const entry = { stopped: false }
        played.push(entry)
        return { stop: () => (entry.stopped = true) }
      },
    }
    const queue = createPlaybackQueue({ sink })
    const { core, client, events } = await setup({ audio: both })
    const feed = () => {
      for (const e of events.splice(0)) queue.handle(e)
    }

    const first = core.pushAudio({ chunks: [Int16Array.from([1]), Int16Array.from([2])], end: false })
    await waitUntil(() => events.filter((e) => e.type === 'chunk').length === 2, 3000, 'chunks')
    feed()
    expect(queue.scheduled).toBe(2)
    core.stopAudio(first)
    await waitUntil(() => events.some((e) => e.type === 'stop'), 3000, 'audio.stop')
    feed()
    expect(queue.scheduled).toBe(0)
    expect(queue.playing).toBe(false)
    expect(played.every((p) => p.stopped)).toBe(true)

    core.pushAudio({ chunks: [Int16Array.from([3])], end: false })
    await waitUntil(() => events.some((e) => e.type === 'chunk'), 3000, 'second stream')
    feed()
    expect(queue.scheduled).toBe(1)
    expect(client.send('Actually, stop.')).toEqual({ ok: true })
    expect(events).toEqual([{ type: 'flush', reason: 'input' }])
    feed()
    expect(queue.scheduled).toBe(0)
    expect(played.at(-1)?.stopped).toBe(true)
  })
})
