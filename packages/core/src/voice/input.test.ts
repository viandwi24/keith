import { describe, expect, test } from 'bun:test'
import { createVoice } from './index.ts'
import {
  createFakeStt,
  createFakeTts,
  createFakeVad,
  createHarness,
  LOUD,
  nodeId,
  personId,
  settle,
  streamId,
  threadId,
  tone,
  voiceConfig,
} from './test-fakes.ts'

const NODE = nodeId(1)
const START = {
  nodeId: NODE,
  personId: personId(1),
  threadId: threadId(1),
  streamId: streamId(1),
  codec: 'pcm16' as const,
  sampleRate: 16_000,
}

function setup(opts: Parameters<typeof createHarness>[0] & { texts?: string[] } = {}) {
  const vad = createFakeVad()
  const stt = createFakeStt(opts.texts ?? ['turn on the lights'])
  const h = createHarness({ vad, stt, tts: createFakeTts(), ...opts })
  const voice = createVoice(h.deps)
  let seq = 0
  const send = (bytes: Uint8Array, id = START.streamId) =>
    voice.input.chunk({ nodeId: NODE, streamId: id, sequence: seq++, payload: bytes })
  /** 20 ms chunks. */
  const feed = (ms: number, value: number) => {
    for (let t = 0; t < ms; t += 20) send(tone(20, value))
  }
  return { ...h, vad, stt, voice, send, feed }
}

describe('VoiceInput', () => {
  test('a synthetic utterance between silences becomes exactly one audio input', async () => {
    const t = setup()
    expect(t.voice.input.start(START)).toEqual({ ok: true })
    t.feed(400, 0)
    t.feed(600, LOUD)
    t.feed(400, 0)
    await settle()
    expect(t.inputs).toEqual([
      {
        threadId: START.threadId,
        personId: START.personId,
        nodeId: NODE,
        modality: 'audio',
        text: 'turn on the lights',
      },
    ])
    // The utterance is the speech plus up to PREROLL_MS before it, at the pipeline rate.
    const call = t.stt.calls[0]
    expect(call?.sampleRate).toBe(16_000)
    expect(call?.codec).toBe('pcm16')
    expect(call?.samples).toBeGreaterThanOrEqual(16 * 600)
    expect(call?.samples).toBeLessThanOrEqual(16 * (600 + 300 + 20))
  })

  test('speech.start maps to voiceActivity(true); input follows without a speaking:false', async () => {
    const t = setup()
    t.voice.input.start(START)
    t.feed(100, 0)
    t.feed(200, LOUD)
    expect(t.activity).toEqual([{ threadId: START.threadId, nodeId: NODE, speaking: true }])
    t.feed(100, 0)
    await settle()
    expect(t.activity).toHaveLength(1)
    expect(t.inputs).toHaveLength(1)
  })

  test('an empty transcript produces no input and sends voiceActivity(false)', async () => {
    const t = setup({ texts: ['  '] })
    t.voice.input.start(START)
    t.feed(200, LOUD)
    t.feed(100, 0)
    await settle()
    expect(t.inputs).toEqual([])
    expect(t.activity.map((a) => a.speaking)).toEqual([true, false])
  })

  test('maxUtteranceMs forces an STT run while speech goes on', async () => {
    const t = setup({ config: voiceConfig({ maxUtteranceMs: 1_000 }), texts: ['first part', 'second part'] })
    t.voice.input.start(START)
    t.feed(2_500, LOUD)
    await settle()
    expect(t.stt.calls.length).toBe(2)
    expect(t.inputs.map((i) => i.text)).toEqual(['first part', 'second part'])
    // Still one speech: no second speaking:true that would read as a barge-in.
    expect(t.activity.map((a) => a.speaking)).toEqual([true])
  })

  test('audio.end sends the buffered utterance to STT', async () => {
    const t = setup()
    t.voice.input.start(START)
    t.feed(300, LOUD)
    expect(t.voice.input.end({ nodeId: NODE, streamId: START.streamId })).toBe(true)
    await settle()
    expect(t.inputs.map((i) => i.text)).toEqual(['turn on the lights'])
    expect(t.vad.closed).toBe(1)
    // The stream is gone.
    expect(t.send(tone(20, 0))).toBe(false)
    expect(t.voice.input.end({ nodeId: NODE, streamId: START.streamId })).toBe(false)
  })

  test('bargeInMinMs: speech shorter than it sends no voiceActivity, but its transcript still counts', async () => {
    const t = setup({ config: voiceConfig({ bargeInMinMs: 300 }), texts: ['yes'] })
    t.voice.input.start(START)
    t.feed(200, LOUD)
    t.feed(100, 0)
    await settle()
    expect(t.activity).toEqual([])
    expect(t.inputs.map((i) => i.text)).toEqual(['yes'])

    t.feed(400, LOUD)
    expect(t.activity.map((a) => a.speaking)).toEqual([true])
  })

  test('out-of-order chunks are dropped and logged at debug; unknown streams return false', () => {
    const t = setup()
    t.voice.input.start(START)
    expect(
      t.voice.input.chunk({ nodeId: NODE, streamId: START.streamId, sequence: 5, payload: tone(20, 0) }),
    ).toBe(true)
    expect(
      t.voice.input.chunk({ nodeId: NODE, streamId: START.streamId, sequence: 3, payload: tone(20, 0) }),
    ).toBe(true)
    expect(
      t.log.entries.some((e) => e.level === 'debug' && e.msg === 'out-of-order audio chunk dropped'),
    ).toBe(true)
    expect(
      t.voice.input.chunk({ nodeId: NODE, streamId: streamId(9), sequence: 0, payload: tone(20, 0) }),
    ).toBe(false)
    expect(
      t.voice.input.chunk({ nodeId: nodeId(2), streamId: START.streamId, sequence: 6, payload: tone(20, 0) }),
    ).toBe(false)
  })

  test('odd-length payloads never throw', () => {
    const t = setup()
    t.voice.input.start(START)
    expect(t.send(new Uint8Array([1, 2, 3]))).toBe(true)
    expect(t.send(new Uint8Array([7]))).toBe(true)
  })

  test('start refuses opus, bad rates, reused stream ids and missing providers', () => {
    const t = setup()
    expect(t.voice.input.start({ ...START, codec: 'opus' })).toMatchObject({
      ok: false,
      code: 'INVALID_FRAME',
    })
    expect(t.voice.input.start({ ...START, sampleRate: 4_000 })).toMatchObject({ ok: false })
    expect(t.voice.input.start(START)).toEqual({ ok: true })
    expect(t.voice.input.start(START)).toMatchObject({
      ok: false,
      message: expect.stringContaining('already open'),
    })
    // Another node may use the same stream id.
    expect(t.voice.input.start({ ...START, nodeId: nodeId(2) })).toEqual({ ok: true })

    const bare = createHarness({ vad: createFakeVad() })
    const voice = createVoice(bare.deps)
    expect(voice.input.start(START)).toMatchObject({
      ok: false,
      message: 'stt provider fake-stt is not registered',
    })
  })

  test('voice off: input streams are refused with a logged warning', () => {
    const t = setup({ config: undefined })
    expect(t.voice.input.start(START)).toEqual({
      ok: false,
      code: 'INVALID_FRAME',
      message: 'voice is not configured',
    })
    expect(t.log.entries.some((e) => e.level === 'warn' && e.msg.includes('voice is not configured'))).toBe(
      true,
    )
  })

  test('another sample rate is resampled to 16 kHz for the VAD and STT', async () => {
    const t = setup()
    t.voice.input.start({ ...START, sampleRate: 48_000 })
    let seq = 0
    const feed48 = (ms: number, v: number) => {
      for (let x = 0; x < ms; x += 20) {
        t.voice.input.chunk({
          nodeId: NODE,
          streamId: START.streamId,
          sequence: seq++,
          payload: tone(20, v, 48_000),
        })
      }
    }
    feed48(400, LOUD)
    feed48(100, 0)
    await settle()
    expect(t.vad.rates).toEqual([16_000])
    expect(t.stt.calls[0]?.sampleRate).toBe(16_000)
    expect(t.stt.calls[0]?.samples).toBeGreaterThanOrEqual(16 * 400)
    expect(t.stt.calls[0]?.samples).toBeLessThanOrEqual(16 * 520)
  })

  test('detach drops open streams without STT and returns the thread to idle', async () => {
    const t = setup()
    t.voice.input.start(START)
    t.feed(300, LOUD)
    t.voice.input.detach(NODE)
    await settle()
    expect(t.stt.calls).toEqual([])
    expect(t.inputs).toEqual([])
    expect(t.activity.map((a) => a.speaking)).toEqual([true, false])
    expect(t.send(tone(20, 0))).toBe(false)
  })

  test('an STT that only streams is used through stream()', async () => {
    const vad = createFakeVad()
    const h = createHarness({
      vad,
      stt: {
        id: 'fake-stt',
        stream() {
          return {
            push() {},
            end() {},
            async *events() {
              yield { type: 'partial' as const, text: 'hel' }
              yield { type: 'final' as const, text: 'hello' }
            },
          }
        },
      },
    })
    const voice = createVoice(h.deps)
    voice.input.start(START)
    let seq = 0
    for (let x = 0; x < 200; x += 20)
      voice.input.chunk({ nodeId: NODE, streamId: START.streamId, sequence: seq++, payload: tone(20, LOUD) })
    voice.input.end({ nodeId: NODE, streamId: START.streamId })
    await settle()
    expect(h.inputs.map((i) => i.text)).toEqual(['hello'])
  })

  test('an STT failure is logged; no input, and the thread returns to idle', async () => {
    const vad = createFakeVad()
    const h = createHarness({
      vad,
      stt: {
        id: 'fake-stt',
        async transcribe() {
          throw new Error('down')
        },
      },
    })
    const voice = createVoice(h.deps)
    voice.input.start(START)
    let seq = 0
    for (let x = 0; x < 200; x += 20)
      voice.input.chunk({ nodeId: NODE, streamId: START.streamId, sequence: seq++, payload: tone(20, LOUD) })
    voice.input.end({ nodeId: NODE, streamId: START.streamId })
    await settle()
    expect(h.inputs).toEqual([])
    expect(h.activity.map((a) => a.speaking)).toEqual([true, false])
    expect(h.log.entries.some((e) => e.level === 'error' && e.msg === 'stt failed')).toBe(true)
  })
})
