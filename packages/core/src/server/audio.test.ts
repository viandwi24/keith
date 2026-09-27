// Phase 3: audio frames from nodes (docs/contracts/protocol.md#audio-phase-3), against a fake VoiceInput.

import { afterEach, describe, expect, test } from 'bun:test'
import { AUDIO_FRAME_KIND, encodeAudioFrame } from '@keith/protocol'
import type { NodeId, ThreadId } from '../shared/types.ts'
import {
  connect,
  createFakeVoiceInput,
  eventually,
  type FakeVoiceInput,
  login,
  startTestServer,
  type TestClient,
  type TestServer,
} from './test-fakes.ts'

const STREAM = '01J8ZQ3K4M5N6P7Q8R9S0T1V50'
const OTHER_STREAM = '01J8ZQ3K4M5N6P7Q8R9S0T1V51'

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

async function setup(voice: FakeVoiceInput | null = createFakeVoiceInput()) {
  t = await startTestServer(voice ? { voice } : {})
  return t
}

/** Connects with `capabilities`, opens the main thread, and returns its id. */
async function ready(
  s: TestServer,
  capabilities: string[] = ['chat.text@1', 'audio.in@1', 'audio.out@1'],
): Promise<{ client: TestClient; nodeId: NodeId; threadId: ThreadId }> {
  const client = await connect(s.wsUrl(await login(s)))
  const welcome = await client.hello({ capabilities })
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  const thread = opened.data.thread as { id: ThreadId }
  return { client, nodeId: welcome.data.nodeId as NodeId, threadId: thread.id }
}

function startAudio(client: TestClient, threadId: ThreadId, streamId = STREAM, codec = 'pcm16') {
  return client.send('audio.start', { threadId, streamId, codec, sampleRate: 16_000 })
}

function chunk(sequence: number, streamId = STREAM, kind: 1 | 2 = AUDIO_FRAME_KIND.in) {
  // Copied so the type is backed by an ArrayBuffer (WebSocket.send's signature).
  return new Uint8Array(encodeAudioFrame({ kind, streamId, sequence, payload: new Uint8Array([1, 0, 2, 0]) }))
}

describe('audio.start / audio.end', () => {
  test('audio.start reaches VoiceInput.start with the node, person and thread', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const { client, nodeId, threadId } = await ready(s)
    startAudio(client, threadId)
    await eventually(() => voice.calls.start.length === 1)
    expect(voice.calls.start[0]).toEqual({
      nodeId,
      personId: s.owner.id,
      threadId,
      streamId: STREAM,
      codec: 'pcm16',
      sampleRate: 16_000,
    })
    client.send('audio.end', { streamId: STREAM })
    await eventually(() => voice.calls.end.length === 1)
    expect(voice.calls.end[0]).toEqual({ nodeId, streamId: STREAM })
    expect(client.frames.some((f) => f.type === 'error')).toBe(false)
  })

  test('audio.start without audio.in@1 gets FORBIDDEN', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const { client, threadId } = await ready(s, ['chat.text@1'])
    const id = startAudio(client, threadId)
    const error = await client.next('error')
    expect(error.data.code).toBe('FORBIDDEN')
    expect(error.re).toBe(id)
    expect(voice.calls.start).toEqual([])
  })

  test('audio.start for a thread not open here gets FORBIDDEN', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello({ capabilities: ['audio.in@1'] })
    startAudio(client, 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31' as ThreadId)
    expect((await client.next('error')).data.code).toBe('FORBIDDEN')
    expect(voice.calls.start).toEqual([])
  })

  test('a refused stream (opus in v1) gets INVALID_FRAME with the VoiceInput message', async () => {
    const s = await setup()
    const { client, threadId } = await ready(s)
    const id = startAudio(client, threadId, STREAM, 'opus')
    const error = await client.next('error')
    expect(error.data).toEqual({ code: 'INVALID_FRAME', message: 'codec not supported' })
    expect(error.re).toBe(id)
  })

  test('audio.end of an unknown stream gets INVALID_FRAME', async () => {
    const s = await setup()
    const { client } = await ready(s)
    client.send('audio.end', { streamId: OTHER_STREAM })
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
  })

  test('without voice, audio frames get INVALID_FRAME "voice is not configured"', async () => {
    const s = await setup(null)
    const { client, threadId } = await ready(s)
    startAudio(client, threadId)
    expect((await client.next('error')).data).toEqual({
      code: 'INVALID_FRAME',
      message: 'voice is not configured',
    })
    client.ws.send(chunk(0))
    expect((await client.next('error')).data).toEqual({
      code: 'INVALID_FRAME',
      message: 'voice is not configured',
    })
  })
})

describe('binary frames', () => {
  test('a valid kind-1 chunk reaches VoiceInput.chunk with its stream id, sequence and payload', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const { client, nodeId, threadId } = await ready(s)
    startAudio(client, threadId)
    // Sent right after audio.start: frames are handled in order, so the chunk finds its stream.
    client.ws.send(chunk(0))
    client.ws.send(chunk(1))
    await eventually(() => voice.calls.chunk.length === 2)
    expect(voice.calls.chunk.map((c) => [c.nodeId, c.streamId, c.sequence])).toEqual([
      [nodeId, STREAM, 0],
      [nodeId, STREAM, 1],
    ])
    expect([...(voice.calls.chunk[0]?.payload ?? [])]).toEqual([1, 0, 2, 0])
    expect(client.frames.some((f) => f.type === 'error')).toBe(false)
  })

  test('garbage, kind 2 and unknown streams get INVALID_FRAME, and the connection stays open', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const { client, threadId } = await ready(s)
    client.ws.send(new Uint8Array([9, 9, 9]))
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
    client.ws.send(new Uint8Array(40).fill(7))
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
    startAudio(client, threadId)
    client.ws.send(chunk(0, STREAM, AUDIO_FRAME_KIND.out))
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
    client.ws.send(chunk(0, OTHER_STREAM))
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
    expect(voice.calls.chunk.map((c) => c.streamId)).toEqual([OTHER_STREAM])
    // Still open: a normal frame still works.
    client.send('thread.open', {})
    await client.next('thread.opened')
  })

  test('a binary frame before hello gets INVALID_FRAME', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    client.ws.send(chunk(0))
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
  })
})

describe('outgoing audio and socket close', () => {
  test('AttachmentRegistry.sendBinary reaches the node as a binary frame', async () => {
    const s = await setup()
    const { client, nodeId } = await ready(s)
    const bytes = chunk(3, STREAM, AUDIO_FRAME_KIND.out)
    s.attachments.sendBinary(nodeId, bytes)
    await eventually(() => client.binary.length === 1)
    expect([...(client.binary[0] ?? [])]).toEqual([...bytes])
  })

  test('socket close detaches the node from VoiceInput', async () => {
    const voice = createFakeVoiceInput()
    const s = await setup(voice)
    const { client, nodeId, threadId } = await ready(s)
    startAudio(client, threadId)
    await eventually(() => voice.calls.start.length === 1)
    await client.close()
    await eventually(() => voice.calls.detach.length === 1)
    expect(voice.calls.detach).toEqual([nodeId])
  })
})
