// Phase 3 integration (P3-I1): the real core with the real voice plugins loaded by package name
// (`@keith/vad-energy`, `@keith/voice-groq`, `@keith/voice-openai`), whose vendor APIs are a local
// fake server. A protocol node sends PCM16 speech; the reply's audio goes to that node only.

import { afterEach, describe, expect, test } from 'bun:test'
import { AUDIO_FRAME_KIND, decodeAudioFrame, encodeAudioFrame } from '@keith/protocol'
import { isKeithError } from '@keith/sdk'
import { createFakeLlm, createFakeLlmPlugin, fakeText } from '@keith/sdk/testing'
import { bootstrap } from '../src/bootstrap.ts'
import { connect, eventually, type ReceivedFrame, type TestClient } from '../src/server/test-fakes.ts'
import type { ThreadId } from '../src/shared/types.ts'
import { createOwner, createTestHome, login, quietLogger, testClock, wsUrl } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const TRANSCRIPT = 'what time is it'
const RATE = 16_000
const CHUNK_MS = 20
const CHUNK_SAMPLES = (RATE * CHUNK_MS) / 1000
const STREAM_ID = '01HZX3V8K2M4N6P8R0T2W4Y6Z8'
const TTS_RATE = 24_000

type SpeechReply = (n: number) => Response

/** 100 ms of PCM16 at 24 kHz. */
const ttsChunk = () => new Uint8Array((TTS_RATE / 10) * 2).fill(7)

/** A TTS body that trickles a chunk every 100 ms for `ms` (a long spoken reply). */
function slowSpeech(ms: number): Response {
  let timer: ReturnType<typeof setInterval> | undefined
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        sent += 100
        if (sent > ms) {
          clearInterval(timer)
          controller.close()
          return
        }
        controller.enqueue(ttsChunk())
      }, 100)
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(body, { headers: { 'content-type': 'audio/pcm' } })
}

const fastSpeech = () => new Response(ttsChunk(), { headers: { 'content-type': 'audio/pcm' } })

/** The Groq and OpenAI audio endpoints the plugins call, served locally. */
function fakeVendor(speech: SpeechReply = fastSpeech) {
  const calls = { stt: 0, tts: [] as string[] }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/v1/audio/transcriptions') {
        calls.stt += 1
        await req.formData()
        return Response.json({ text: TRANSCRIPT })
      }
      if (path === '/v1/audio/speech') {
        const body = (await req.json()) as { input: string }
        calls.tts.push(body.input)
        return speech(calls.tts.length)
      }
      return new Response('not found', { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true))
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, calls }
}

function voiceConfig(baseUrl: string, voice: { stt?: string; bargeInMinMs?: number } = {}): string {
  return `
[server]
port = 0

[models]
foreground = "fake:scripted"
background = "fake:scripted"
utility    = "fake:scripted"

[plugins]
enabled  = ["@keith/vad-energy", "@keith/voice-groq", "@keith/voice-openai"]
required = []
stopTimeoutMs = 500

[plugins."@keith/voice-groq"]
apiKey = "env:GROQ_API_KEY"
baseUrl = ${JSON.stringify(baseUrl)}

[plugins."@keith/voice-openai"]
apiKey = "env:OPENAI_API_KEY"
baseUrl = ${JSON.stringify(baseUrl)}

[voice]
vad = "energy"
stt = ${JSON.stringify(voice.stt ?? 'groq')}
tts = "openai"
bargeInMinMs = ${voice.bargeInMinMs ?? 0}
`
}

async function start(config: string, fake = createFakeLlm()) {
  const home = await createTestHome(config)
  cleanups.push(() => home.remove())
  const clock = testClock()
  await createOwner(home.dir, clock)
  const keith = await bootstrap({
    home: home.dir,
    env: { GROQ_API_KEY: 'gsk-test', OPENAI_API_KEY: 'sk-test' },
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log: quietLogger(clock),
  })
  cleanups.push(() => keith.stop())
  return { keith, fake }
}

async function node(
  url: string,
  capabilities: string[],
): Promise<{ client: TestClient; threadId: ThreadId }> {
  const client = await connect(wsUrl(url, await login(url)))
  cleanups.push(() => client.close())
  await client.hello({ capabilities })
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  return { client, threadId: (opened.data.thread as { id: ThreadId }).id }
}

/** `ms` of PCM16 at 16 kHz: a 440 Hz tone at `amplitude` (0 = silence), in 20 ms chunks. */
function pcmChunks(ms: number, amplitude: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let t = 0; t < ms; t += CHUNK_MS) {
    const samples = new Int16Array(CHUNK_SAMPLES)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (i + (t * RATE) / 1000)) / RATE))
    }
    out.push(new Uint8Array(samples.buffer))
  }
  return out
}

/** A mic stream on one node: `audio.start`, kind-1 binary chunks, `audio.end`. */
function mic(client: TestClient, threadId: ThreadId) {
  let sequence = 0
  const send = (payload: Uint8Array) =>
    client.ws.send(
      encodeAudioFrame({
        kind: AUDIO_FRAME_KIND.in,
        streamId: STREAM_ID,
        sequence: sequence++,
        payload,
      }) as Uint8Array<ArrayBuffer>,
    )
  return {
    start: () =>
      client.send('audio.start', { threadId, streamId: STREAM_ID, codec: 'pcm16', sampleRate: RATE }),
    /** Sends the chunks at once (faster than real time). */
    burst: (chunks: Uint8Array[]) => {
      for (const c of chunks) send(c)
    },
    /** Sends 20 ms chunks in real time until `until()` holds or `maxMs` passed. */
    async paced(amplitude: number, until: () => boolean, maxMs: number) {
      const [chunk] = pcmChunks(CHUNK_MS, amplitude)
      const started = Date.now()
      while (!until() && Date.now() - started < maxMs) {
        if (chunk) send(chunk)
        await Bun.sleep(CHUNK_MS)
      }
    },
    end: () => client.send('audio.end', { streamId: STREAM_ID }),
  }
}

const utterance = () => [...pcmChunks(400, 0), ...pcmChunks(600, 8_000), ...pcmChunks(800, 0)]

const messageOf = (f: ReceivedFrame) =>
  f.data.message as { role: string; modality: string; content: string; meta: Record<string, unknown> | null }

describe('voice through bootstrap', () => {
  test('a bad voice.stt id fails startup with CONFIG_INVALID naming the registered ids', async () => {
    const { baseUrl } = fakeVendor()
    const error = await start(voiceConfig(baseUrl, { stt: 'whisper-typo' })).catch((e: unknown) => e)
    expect(isKeithError(error, 'CONFIG_INVALID')).toBe(true)
    const message = (error as Error).message
    expect(message).toContain("voice.stt = 'whisper-typo'")
    expect(message).toContain('registered: groq')
  })

  test('S-7: speech on one node becomes an audio message; the spoken reply goes to that node only', async () => {
    const vendor = fakeVendor()
    const { keith } = await start(
      voiceConfig(vendor.baseUrl),
      createFakeLlm([fakeText('It is noon. Enjoy lunch.', 5)]),
    )
    expect(keith.plugins.status().map((p) => [p.id, p.state])).toEqual(
      expect.arrayContaining([
        ['@keith/vad-energy', 'started'],
        ['@keith/voice-groq', 'started'],
        ['@keith/voice-openai', 'started'],
      ]),
    )
    const typist = await node(keith.url, ['chat.text@1'])
    const speaker = await node(keith.url, ['chat.text@1', 'audio.in@1', 'audio.out@1'])
    expect(speaker.threadId).toBe(typist.threadId)
    const threadId = speaker.threadId

    const m = mic(speaker.client, threadId)
    m.start()
    m.burst(utterance())
    m.end()

    // The transcript is a user message with modality audio, seen by both nodes.
    const userB = messageOf(await speaker.client.next('message.user', 5_000))
    expect(userB).toMatchObject({ role: 'user', modality: 'audio', content: TRANSCRIPT })
    expect(messageOf(await typist.client.next('message.user', 5_000))).toMatchObject({
      role: 'user',
      modality: 'audio',
    })
    expect(vendor.calls.stt).toBe(1)

    // The reply: text on both nodes, streamed live to the text-only node too.
    const replyB = messageOf(await speaker.client.next('message.completed', 5_000))
    const replyA = messageOf(await typist.client.next('message.completed', 5_000))
    expect(replyB).toMatchObject({ role: 'assistant', content: 'It is noon. Enjoy lunch.' })
    expect(replyA.content).toBe(replyB.content)
    expect(typist.client.frames.some((f) => f.type === 'message.delta')).toBe(true)

    // Audio: framed by audio.start/audio.end, kind-2 frames in order, on the speaker only.
    const audioStart = await speaker.client.next('audio.start')
    expect(audioStart.data).toMatchObject({ threadId, codec: 'pcm16', sampleRate: TTS_RATE })
    await speaker.client.next('audio.end')
    const frames = speaker.client.binary.map((b) => decodeAudioFrame(b))
    expect(frames.length).toBeGreaterThan(0)
    frames.forEach((f, i) => {
      expect(f.ok && f.frame.kind === AUDIO_FRAME_KIND.out && f.frame.sequence === i).toBe(true)
      expect(f.ok && f.frame.streamId).toBe(audioStart.data.streamId as string)
    })
    expect(vendor.calls.tts.map((t) => t.trim())).toEqual(['It is noon.', 'Enjoy lunch.'])
    expect(typist.client.binary).toEqual([])
    expect(typist.client.frames.some((f) => f.type.startsWith('audio.'))).toBe(false)

    // Persisted: the user message keeps its modality; the spoken reply is stored as audio (I-6).
    await keith.threads.idle()
    const { messages: history } = await keith.repos.messages.page({ threadId, limit: 10 })
    expect(history.map((h) => [h.role, h.modality, h.content])).toEqual([
      ['user', 'audio', TRANSCRIPT],
      ['assistant', 'audio', 'It is noon. Enjoy lunch.'],
    ])
  })

  test('barge-in through the real pipeline fires about bargeInMinMs after speech starts, not twice that', async () => {
    const BARGE_IN_MS = 500
    // The second TTS piece plays for 5 s, so the reply is still speaking when the person talks.
    const vendor = fakeVendor((n) => (n === 2 ? slowSpeech(5_000) : fastSpeech()))
    const reply = 'First sentence here. Second one takes a while to say.'
    const { keith } = await start(
      voiceConfig(vendor.baseUrl, { bargeInMinMs: BARGE_IN_MS }),
      createFakeLlm([fakeText(reply), fakeText('Go on.')]),
    )
    const speaker = await node(keith.url, ['chat.text@1', 'audio.in@1', 'audio.out@1'])
    const m = mic(speaker.client, speaker.threadId)
    m.start()
    m.burst(utterance())
    await speaker.client.next('audio.start', 5_000)
    await eventually(() => vendor.calls.tts.length === 2, 5_000)

    // Speak over the reply, in real time, until the core stops the audio.
    const stopped = () => speaker.client.frames.some((f) => f.type === 'audio.stop')
    const onset = Date.now()
    await m.paced(8_000, stopped, 3_000)
    const elapsed = Date.now() - onset
    expect(stopped()).toBe(true)
    // energy VAD confirms speech after ~120 ms of audio, then the Mind waits bargeInMinMs once.
    // Applied twice it would be ~120 + 2 × 500 ms.
    expect(elapsed).toBeGreaterThanOrEqual(BARGE_IN_MS)
    expect(elapsed).toBeLessThan(BARGE_IN_MS + 450)

    // The cut reply keeps only what was spoken.
    const cut = messageOf(await speaker.client.next('message.completed', 5_000))
    expect(cut.role).toBe('assistant')
    expect(cut.meta).toMatchObject({ cancelled: true })
    const spokenChars = cut.meta?.spokenChars as number
    expect(spokenChars).toBeGreaterThan(0)
    expect(spokenChars).toBeLessThan(reply.length)
    expect(cut.content).toBe(reply.slice(0, spokenChars))
    expect(cut.content).toStartWith('First sentence here.')

    // The barge-in's own words still become the next input.
    m.burst(pcmChunks(800, 0))
    m.end()
    await speaker.client.next('message.user', 5_000)
    const next = messageOf(await speaker.client.next('message.user', 5_000))
    expect(next).toMatchObject({ role: 'user', modality: 'audio', content: TRANSCRIPT })
    await speaker.client.next('message.completed', 5_000)
  })
})
