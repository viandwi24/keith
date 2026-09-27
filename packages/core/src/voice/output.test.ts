import { describe, expect, test } from 'bun:test'
import { AUDIO_FRAME_KIND, type CoreFrame, decodeAudioFrame } from '@keith/protocol'
import { AUDIO_OUT_CAPABILITY, createVoice } from './index.ts'
import {
  createFakeTts,
  createHarness,
  nodeId,
  type Sent,
  settle,
  threadId,
  voiceConfig,
} from './test-fakes.ts'

const NODE = nodeId(1)
const MESSAGE = 'msg_00000000000000000000000077' as const
const BEGIN = { threadId: threadId(1), nodeId: NODE, messageId: MESSAGE }

function setup(tts = createFakeTts(), opts: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ tts, capabilities: { [NODE]: [AUDIO_OUT_CAPABILITY] }, ...opts })
  return { ...h, tts, voice: createVoice(h.deps) }
}

const frames = (sent: Sent[]): CoreFrame[] => sent.flatMap((s) => ('frame' in s ? [s.frame] : []))
const kinds = (sent: Sent[]) => sent.map((s) => ('frame' in s ? s.frame.type : 'binary'))

describe('VoiceOutput', () => {
  test('sentences are spoken in order as kind-2 frames between audio.start and audio.end', async () => {
    const t = setup()
    const speech = t.voice.output.begin(BEGIN)
    expect(speech).not.toBeNull()
    speech?.push('Hello there. How ')
    speech?.push('are you? I am')
    speech?.push(' fine')
    speech?.end()
    await speech?.done

    expect(t.tts.texts).toEqual(['Hello there.', 'How are you?', 'I am fine'])
    expect(kinds(t.sent)).toEqual(['audio.start', ...Array(6).fill('binary'), 'audio.end'])
    expect(t.sent.every((s) => s.nodeId === NODE)).toBe(true)

    const start = frames(t.sent)[0]
    if (start?.type !== 'audio.start') throw new Error('expected audio.start')
    expect(start.data).toMatchObject({
      threadId: BEGIN.threadId,
      messageId: MESSAGE,
      codec: 'pcm16',
      sampleRate: 24_000,
    })
    const streamId = start.data.streamId

    const chunks = t.sent.flatMap((s) => ('bytes' in s ? [s.bytes] : []))
    const decoded = chunks.map((b) => {
      const r = decodeAudioFrame(b)
      if (!r.ok) throw new Error(r.message)
      return r.frame
    })
    expect(decoded.map((f) => f.kind)).toEqual(Array(6).fill(AUDIO_FRAME_KIND.out))
    expect(decoded.map((f) => f.streamId)).toEqual(Array(6).fill(streamId))
    expect(decoded.map((f) => f.sequence)).toEqual([0, 1, 2, 3, 4, 5])
    // Sentence order: the fake fills sentence n's samples with n*10 + chunk.
    expect(decoded.map((f) => new DataView(f.payload.buffer).getInt16(0, true))).toEqual([
      10, 11, 20, 21, 30, 31,
    ])
    const end = frames(t.sent).at(-1)
    expect(end).toMatchObject({ type: 'audio.end', data: { streamId } })
  })

  test('stop() mid-reply aborts TTS, sends audio.stop and counts only fully sent sentences', async () => {
    // Sentence 1 is fully sent; sentence 2 sends one chunk, then waits until aborted.
    const t = setup(createFakeTts({ holdText: 2 }))
    const speech = t.voice.output.begin(BEGIN)
    if (!speech) throw new Error('expected a speech handle')
    const first = 'One two. '
    speech.push(first)
    speech.push('Three four. Five six. Seven')
    await settle()
    expect(t.tts.texts).toEqual(['One two.', 'Three four.'])
    expect(kinds(t.sent)).toEqual(['audio.start', 'binary', 'binary', 'binary'])

    const spoken = speech.stop()
    expect(spoken).toBe(first.length)
    expect(speech.stop()).toBe(first.length)
    await speech.done
    await settle()

    expect(t.tts.signals.at(-1)?.aborted).toBe(true)
    expect(t.tts.texts).toHaveLength(2)
    expect(kinds(t.sent)).toEqual(['audio.start', 'binary', 'binary', 'binary', 'audio.stop'])
    const before = t.sent.length
    speech.push('more text. ')
    speech.end()
    await settle()
    expect(t.sent.length).toBe(before)
  })

  test('stop() before any audio sends nothing and returns 0', async () => {
    const t = setup()
    const speech = t.voice.output.begin(BEGIN)
    speech?.push('Not yet a sentence')
    expect(speech?.stop()).toBe(0)
    await speech?.done
    expect(t.sent).toEqual([])
  })

  test('spokenChars after a full reply covers all pushed text', async () => {
    const t = setup()
    const speech = t.voice.output.begin(BEGIN)
    const text = 'Hi. Bye.\n'
    speech?.push(text)
    speech?.end()
    await speech?.done
    expect(speech?.stop()).toBe(text.length)
    expect(frames(t.sent).at(-1)?.type).toBe('audio.end')
  })

  test('voice off, a node without audio.out@1, or a missing TTS provider: begin returns null', () => {
    expect(setup(createFakeTts(), { config: undefined }).voice.output.begin(BEGIN)).toBeNull()
    expect(
      setup(createFakeTts(), { capabilities: { [NODE]: ['ui@1'] } }).voice.output.begin(BEGIN),
    ).toBeNull()
    const missing = setup(createFakeTts(), { config: voiceConfig({ tts: 'other' }) })
    expect(missing.voice.output.begin(BEGIN)).toBeNull()
  })

  test('a TTS error is logged and ends the speech early with audio.end', async () => {
    const t = setup(createFakeTts({ failOn: 'Bad' }))
    const speech = t.voice.output.begin(BEGIN)
    speech?.push('Good one. Bad one. Never spoken. ')
    speech?.end()
    await speech?.done
    expect(t.tts.texts).toEqual(['Good one.', 'Bad one.'])
    expect(kinds(t.sent)).toEqual(['audio.start', 'binary', 'binary', 'audio.end'])
    expect(speech?.stop()).toBe('Good one. '.length)
    expect(t.log.entries.some((e) => e.level === 'error')).toBe(true)
  })

  test('large TTS chunks are split into frames within AUDIO_FRAME_MAX_BYTES', async () => {
    const t = setup(createFakeTts({ chunksPerText: 1, samplesPerChunk: 50_000 }))
    const speech = t.voice.output.begin(BEGIN)
    speech?.push('Long.')
    speech?.end()
    await speech?.done
    const sizes = t.sent.flatMap((s) => ('bytes' in s ? [s.bytes.byteLength] : []))
    expect(sizes.length).toBe(2)
    expect(sizes.every((n) => n <= 64 * 1024)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100_000 + 2 * 21)
  })
})
