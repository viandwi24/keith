// S-7 "Switch device and modality mid-conversation" (docs/concept/scenarios.md), in a real browser.
//
// Keith runs with the real `@keith/web` app and the real `@keith/vad-energy` (both loaded by
// package name, as `keith start` loads them), plus the real Groq STT and OpenAI TTS adapters
// behind a fake `fetch`: STT returns scripted transcripts, TTS returns scripted PCM. A TUI-like
// node (`chat.text@1` only) types first. Then Chromium, whose fake microphone plays a generated WAV
// (speech-like bursts between silences, looped by Chromium), opens the same thread with the mic on.
// Its speech moves the focus to the browser: the browser hears the reply, the TUI reads it (I-6,
// I-7). Speaking over a long reply cuts it (barge-in), and the next turn answers the interruption.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { AUDIO_FRAME_KIND, type AudioFrame, decodeAudioFrame } from '../../packages/protocol/src/index.ts'
import { definePlugin } from '../../packages/sdk/src/index.ts'
import { fakeText } from '../../packages/sdk/src/testing/index.ts'
import { createGroqStt } from '../../plugins/voice-groq/src/index.ts'
import { createOpenAITts, OPENAI_PCM_SAMPLE_RATE } from '../../plugins/voice-openai/src/index.ts'
import { type BuiltWebApp, buildWebApp, launchChromium } from './browser.ts'
import {
  addPerson,
  connectNode,
  createHome,
  type E2eNode,
  type E2ePerson,
  e2eClock,
  e2eConfig,
  eventually,
  type Keith,
  scriptedLlm,
  scriptedProvider,
  startKeith,
} from './harness.ts'

/** Browser and speech steps get more time than protocol frames: audio runs in real time. */
const UI_WAIT_MS = 10_000
const SPEECH_WAIT_MS = 15_000
/** Opening the fake mic; a hung `getUserMedia` is retried on a fresh page after this. */
const MIC_OPEN_MS = 8_000
const MIC_ATTEMPTS = 3
const S7_TIMEOUT_MS = 90_000

const BARGE_IN_MIN_MS = 300

// The conversation.
const TYPED = 'Keith, is the lab quiet this afternoon?'
const TYPED_REPLY = 'Quiet as a library, sir.'
const SPOKEN_1 = "I'm on my phone now. Can you hear me?"
const REPLY_1 = 'Loud and clear, sir.'
const SPOKEN_2 = 'Tell me the long version.'
const REPLY_2_FIRST = 'Here is the long version.'
const REPLY_2 = `${REPLY_2_FIRST} It goes on for quite a while, sir, and nobody stops it.`
const SPOKEN_3 = 'Stop. What time is it?'
const REPLY_3 = 'It is half past four, sir.'
const TRANSCRIPTS = [SPOKEN_1, SPOKEN_2, SPOKEN_3]

// ---------------------------------------------------------------------------------------------
// The fake microphone: a generated WAV that Chromium plays (and loops) as its capture device.

const WAV_RATE = 48_000
/** One loop of the fake mic: silence, a speech-like burst, silence. */
const LOOP = { leadMs: 1_000, speechMs: 900, tailMs: 2_100 }

/**
 * Speech-like audio: a buzzy voiced source (harmonics of a gliding ~140 Hz pitch) plus a little
 * noise, under a syllable-rate envelope. It survives the browser's noise suppression, which would
 * flatten steady noise, and it clears the energy VAD's start threshold for the whole burst.
 */
function speechLike(ms: number, seed: number): Float32Array {
  const n = Math.round((WAV_RATE * ms) / 1000)
  const out = new Float32Array(n)
  let rand = seed
  const noise = () => {
    rand = (rand * 1_103_515_245 + 12_345) % 2_147_483_648
    return rand / 1_073_741_824 - 1
  }
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / WAV_RATE
    const f0 = 140 + 20 * Math.sin(2 * Math.PI * 1.5 * t)
    phase += (2 * Math.PI * f0) / WAV_RATE
    let voiced = 0
    for (let h = 1; h <= 8; h++) voiced += Math.sin(h * phase) / h
    const envelope = 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4 * t))
    // 10 ms fades, so the burst has no click at either end.
    const fade = Math.min(1, i / (WAV_RATE * 0.01), (n - i) / (WAV_RATE * 0.01))
    out[i] = fade * envelope * (0.3 * voiced + 0.05 * noise())
  }
  return out
}

/** A 16-bit mono WAV holding one loop: silence, a speech-like burst, silence. */
function fakeMicWav(): Uint8Array {
  const samples = (ms: number) => Math.round((WAV_RATE * ms) / 1000)
  const burst = speechLike(LOOP.speechMs, 7)
  const total = samples(LOOP.leadMs) + burst.length + samples(LOOP.tailMs)
  const pcm = new Int16Array(total)
  const offset = samples(LOOP.leadMs)
  burst.forEach((v, i) => {
    pcm[offset + i] = Math.round(Math.max(-1, Math.min(1, v)) * 32_767)
  })
  const wav = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(wav.buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, WAV_RATE, true)
  view.setUint32(28, WAV_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  wav.set(new Uint8Array(pcm.buffer), 44)
  return wav
}

// ---------------------------------------------------------------------------------------------
// Fake vendors: Groq's transcription endpoint and OpenAI's speech endpoint, behind `fetch`.

/** 100 ms of a 330 Hz tone at the TTS rate, as PCM16LE bytes. */
function ttsChunk(): Uint8Array {
  const samples = OPENAI_PCM_SAMPLE_RATE / 10
  const pcm = Int16Array.from({ length: samples }, (_, i) =>
    Math.round(6_000 * Math.sin((2 * Math.PI * 330 * i) / OPENAI_PCM_SAMPLE_RATE)),
  )
  return new Uint8Array(pcm.buffer)
}

/** A PCM body that trickles a 100 ms chunk every 100 ms for `ms`, and stops on abort. */
function trickle(ms: number, signal: AbortSignal | null | undefined): Response {
  let timer: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0
      const stop = () => {
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          // Already closed or cancelled.
        }
      }
      signal?.addEventListener('abort', stop, { once: true })
      timer = setInterval(() => {
        sent += 100
        if (sent > ms) return stop()
        controller.enqueue(ttsChunk())
      }, 100)
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(body, { headers: { 'content-type': 'audio/pcm' } })
}

type FakeVendors = { fetch: typeof fetch; stt: number; tts: string[] }

/**
 * STT answers the scripted transcripts in order. TTS answers 300 ms of audio at once, except for
 * the second sentence of the long reply, which trickles for 10 s (a reply still playing when the
 * owner talks over it).
 */
function fakeVendors(): FakeVendors {
  const vendors: FakeVendors = {
    stt: 0,
    tts: [],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.endsWith('/audio/transcriptions')) {
        const text = TRANSCRIPTS[vendors.stt] ?? 'Hm.'
        vendors.stt += 1
        return Response.json({ text })
      }
      if (url.pathname.endsWith('/audio/speech')) {
        const body = JSON.parse(String(init?.body)) as { input: string }
        vendors.tts.push(body.input.trim())
        if (body.input.trim().startsWith('It goes on')) return trickle(10_000, init?.signal)
        const audio = new Uint8Array([...ttsChunk(), ...ttsChunk(), ...ttsChunk()])
        return new Response(audio, { headers: { 'content-type': 'audio/pcm' } })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch,
  }
  return vendors
}

/** The Groq STT and OpenAI TTS adapters, as a provider plugin, with the fake `fetch`. */
function fakeVoicePlugin(vendors: FakeVendors) {
  return definePlugin({
    id: '@keith/e2e-voice',
    namespace: 'e2e_voice',
    version: '0.0.0',
    kind: 'provider',
    setup(ctx) {
      ctx.providers.stt.register(createGroqStt({ apiKey: 'gsk-test', fetch: vendors.fetch }))
      ctx.providers.tts.register(createOpenAITts({ apiKey: 'sk-test', fetch: vendors.fetch }))
    },
  })
}

// ---------------------------------------------------------------------------------------------
// The browser side.

type PageAudio = {
  /** JSON frames the page's WebSocket received, by type (`audio.*` only). */
  control: { type: string; data: Record<string, unknown> }[]
  /** Decoded binary frames the page received. */
  chunks: AudioFrame[]
  /** Binary frames the page sent (kind 1, its mic). */
  sent: number
}

/** Records the audio the page's WebSocket sends and receives. */
function recordAudio(page: Page): PageAudio {
  const audio: PageAudio = { control: [], chunks: [], sent: 0 }
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') {
        const frame = JSON.parse(payload) as { type: string; data: Record<string, unknown> }
        if (frame.type.startsWith('audio.')) audio.control.push(frame)
        return
      }
      const decoded = decodeAudioFrame(payload)
      if (!decoded.ok) throw new Error(`bad binary frame: ${decoded.message}`)
      audio.chunks.push(decoded.frame)
    })
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') audio.sent += 1
    })
  })
  return audio
}

type BrowserNode = { context: BrowserContext; page: Page; audio: PageAudio; errors: string[] }

/** A fresh browser context with the mic allowed, signed in as `person` on Keith's web app. */
async function openPage(keith: Keith, person: E2ePerson): Promise<BrowserNode> {
  const context = await browser.newContext()
  await context.grantPermissions(['microphone'], { origin: keith.url })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const audio = recordAudio(page)
  await page.goto(`${keith.url}/`, { timeout: UI_WAIT_MS })
  await page.getByLabel('Username').fill(person.username, { timeout: UI_WAIT_MS })
  await page.getByLabel('Password').fill(person.password, { timeout: UI_WAIT_MS })
  await page.getByRole('button', { name: 'Sign in' }).click({ timeout: UI_WAIT_MS })
  await page.waitForSelector('[data-slot="mic-toggle"]:not([disabled])', { timeout: UI_WAIT_MS })
  return { context, page, audio, errors }
}

/** Closes a browser context without waiting forever on a page stuck in `getUserMedia`. */
async function closeContext(node: BrowserNode): Promise<void> {
  await Promise.race([node.context.close().catch(() => undefined), Bun.sleep(UI_WAIT_MS)])
}

/**
 * Turns the open mic on and waits until the page streams audio. Chromium's fake capture device
 * has been seen to hang `getUserMedia` on a first run on macOS: after `MIC_OPEN_MS` the page's
 * context is closed and a fresh one signs in and tries again, up to `MIC_ATTEMPTS` times.
 */
async function openMic(keith: Keith, person: E2ePerson, node: BrowserNode): Promise<BrowserNode> {
  let current = node
  for (let attempt = 1; ; attempt++) {
    const before = current.audio.sent
    try {
      await current.page.click('[data-slot="mic-toggle"]', { timeout: UI_WAIT_MS })
      await current.page.waitForSelector('[data-slot="mic-toggle"][data-state="on"]', {
        timeout: MIC_OPEN_MS,
      })
      await eventually(() => current.audio.sent > before + 10, MIC_OPEN_MS)
      return current
    } catch (error) {
      if (attempt >= MIC_ATTEMPTS)
        throw new Error(`the fake mic did not open in ${attempt} attempts: ${error}`)
      console.warn(`S-7: the fake mic did not open (attempt ${attempt}), retrying in a fresh context`)
      await closeContext(current)
      current = await openPage(keith, person)
    }
  }
}

// ---------------------------------------------------------------------------------------------

let web: BuiltWebApp
let browser: Browser
let wavDir: string

beforeAll(async () => {
  wavDir = await mkdtemp(join(tmpdir(), 'keith-e2e-s7-'))
  const wav = join(wavDir, 'fake-mic.wav')
  await Bun.write(wav, fakeMicWav())
  web = await buildWebApp()
  browser = await launchChromium({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await web?.remove()
  if (wavDir) await rm(wavDir, { recursive: true, force: true })
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const messageIdOf = (f: { data: Record<string, unknown> }) => f.data.messageId as string | undefined
const streamIdOf = (f: { data: Record<string, unknown> }) => f.data.streamId as string | undefined

/** The next spoken input (`message.user` with modality audio) the TUI node sees. */
function heard(tui: E2eNode) {
  return tui.next('message.user', (f) => f.data.message.modality === 'audio', SPEECH_WAIT_MS)
}

/** The TUI node never gets audio: no binary frame and no `audio.*` frame (I-6, I-7). */
function expectNoAudio(tui: E2eNode) {
  expect(tui.binary).toHaveLength(0)
  expect(tui.frames.filter((f) => f.type.startsWith('audio.'))).toEqual([])
}

describe('S-7 switch device and modality mid-conversation', () => {
  test(
    'typed in the TUI, then spoken in the browser: audio follows the focus, text goes everywhere, barge-in cuts the reply',
    async () => {
      // 1. Keith with the web app and the energy VAD (by package name), voice on, the fake vendors.
      const home = await createHome(
        e2eConfig({
          enabled: ['@keith/web', '@keith/vad-energy'],
          extra: [
            `[plugins."@keith/web"]`,
            `distDir = ${JSON.stringify(web.dir)}`,
            '',
            '[voice]',
            'vad = "energy"',
            'stt = "groq"',
            'tts = "openai"',
            `bargeInMinMs = ${BARGE_IN_MIN_MS}`,
            '',
          ].join('\n'),
        }),
      )
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const chat = scriptedLlm([
        fakeText(TYPED_REPLY),
        fakeText(REPLY_1),
        fakeText(REPLY_2, 12),
        fakeText(REPLY_3),
      ])
      const vendors = fakeVendors()
      const { keith } = await startKeith({
        home,
        provider: scriptedProvider({ chat: { llm: chat } }),
        clock,
        plugins: [fakeVoicePlugin(vendors)],
      })
      cleanups.push(() => keith.stop())
      const states = keith.plugins.status().map((p) => [p.id, p.state])
      expect(states).toContainEqual(['@keith/web', 'started'])
      expect(states).toContainEqual(['@keith/vad-energy', 'started'])

      const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })
      const tui = await connectNode(keith, tony, { capabilities: ['chat.text@1'] })
      cleanups.push(() => tui.close())
      const { threadId } = await tui.openMain()

      // The browser is open on the same thread from the start, mic off.
      let web1 = await openPage(keith, tony)
      cleanups.push(() => closeContext(web1))
      const timeline = () => web1.page.locator('[data-slot="timeline"]')
      const messageRow = (id: string) => web1.page.locator(`[data-slot="message"][data-message-id="${id}"]`)

      // 2. Typed input: text on both nodes, no audio anywhere (I-6).
      tui.say(threadId, TYPED)
      const typedReply = await tui.reply(threadId)
      expect(typedReply).toMatchObject({ role: 'assistant', modality: 'text', content: TYPED_REPLY })
      await messageRow(typedReply.id).getByText(TYPED_REPLY).waitFor({ timeout: UI_WAIT_MS })
      expectNoAudio(tui)
      expect(web1.audio.control).toEqual([])
      expect(web1.audio.chunks).toEqual([])
      expect(vendors.tts).toEqual([])

      // 3. The browser speaks: the fake mic's first burst becomes a spoken input.
      web1 = await openMic(keith, tony, web1)
      const heard1 = await heard(tui)
      expect(heard1.data.message).toMatchObject({ role: 'user', modality: 'audio', content: SPOKEN_1 })
      // The browser shows what the core heard (the transcript is echoed to the speaking node).
      await timeline().getByText(SPOKEN_1).waitFor({ timeout: UI_WAIT_MS })

      // Focus moved to the browser: it gets the spoken reply, framed by audio.start / audio.end.
      const reply1 = await tui.reply(threadId, SPEECH_WAIT_MS)
      expect(reply1).toMatchObject({ role: 'assistant', modality: 'audio', content: REPLY_1 })
      await messageRow(reply1.id).getByText(REPLY_1).waitFor({ timeout: UI_WAIT_MS })
      await eventually(() => web1.audio.control.some((f) => f.type === 'audio.end'), UI_WAIT_MS)
      const start1 = web1.audio.control.find((f) => f.type === 'audio.start' && messageIdOf(f) === reply1.id)
      if (!start1) throw new Error('no audio.start for the first spoken reply')
      expect(start1.data).toMatchObject({ threadId, codec: 'pcm16', sampleRate: OPENAI_PCM_SAMPLE_RATE })
      const stream1 = streamIdOf(start1)
      const end1 = web1.audio.control.find((f) => f.type === 'audio.end' && streamIdOf(f) === stream1)
      expect(end1).toBeDefined()
      const chunks1 = web1.audio.chunks.filter((c) => c.streamId === stream1)
      expect(chunks1.length).toBeGreaterThan(0)
      expect(chunks1.every((c) => c.kind === AUDIO_FRAME_KIND.out)).toBe(true)
      expect(chunks1.map((c) => c.sequence)).toEqual(chunks1.map((_, i) => i))
      expect(vendors.tts).toEqual([REPLY_1])
      // The TUI read the same text and heard nothing (I-7).
      expectNoAudio(tui)

      // 4. The next burst asks for a long reply; the one after it talks over the reply (barge-in).
      const heard2 = await heard(tui)
      expect(heard2.data.message.content).toBe(SPOKEN_2)
      await eventually(
        () => web1.audio.control.some((f) => f.type === 'audio.start' && streamIdOf(f) !== stream1),
        SPEECH_WAIT_MS,
      )
      const start2 = web1.audio.control.find((f) => f.type === 'audio.start' && streamIdOf(f) !== stream1)
      const stream2 = start2 && streamIdOf(start2)
      await eventually(
        () => web1.audio.control.some((f) => f.type === 'audio.stop' && streamIdOf(f) === stream2),
        SPEECH_WAIT_MS,
      )
      expect(web1.audio.control.some((f) => f.type === 'audio.end' && streamIdOf(f) === stream2)).toBe(false)
      const chunks2 = web1.audio.chunks.filter((c) => c.streamId === stream2)
      expect(chunks2.length).toBeGreaterThan(0)

      // The cut reply is stored with what was actually spoken (meta.spokenChars), on both nodes.
      const cut = await tui.reply(threadId, SPEECH_WAIT_MS)
      expect(start2 && messageIdOf(start2)).toBe(cut.id)
      expect(cut.meta).toMatchObject({ cancelled: true })
      const spokenChars = cut.meta?.spokenChars as number
      expect(spokenChars).toBeGreaterThan(0)
      expect(spokenChars).toBeLessThan(REPLY_2.length)
      expect(cut.content).toBe(REPLY_2.slice(0, spokenChars))
      expect(cut.content.trim()).toBe(REPLY_2_FIRST)
      await keith.threads.idle()
      const { messages: stored } = await keith.repos.messages.page({ threadId, limit: 20 })
      const storedCut = stored.find((m) => m.id === cut.id)
      expect(storedCut?.meta).toMatchObject({ cancelled: true, spokenChars })
      expect(storedCut?.content).toBe(cut.content)

      // The next turn answers the interruption.
      const heard3 = await heard(tui)
      expect(heard3.data.message.content).toBe(SPOKEN_3)
      const reply3 = await tui.reply(threadId, SPEECH_WAIT_MS)
      expect(reply3).toMatchObject({ role: 'assistant', modality: 'audio', content: REPLY_3 })
      const lastUser = chat.requests[3]?.messages.findLast((m) => m.role === 'user')
      expect(lastUser?.content).toBe(SPOKEN_3)
      await messageRow(reply3.id).getByText(REPLY_3).waitFor({ timeout: UI_WAIT_MS })
      await eventually(
        () => web1.audio.control.some((f) => f.type === 'audio.start' && messageIdOf(f) === reply3.id),
        UI_WAIT_MS,
      )

      // 5. Mic off. The TUI never got audio; the page had no JS errors.
      await web1.page.click('[data-slot="mic-toggle"]')
      await web1.page.waitForSelector('[data-slot="mic-toggle"][data-state="off"]', { timeout: UI_WAIT_MS })
      expectNoAudio(tui)
      expect(web1.errors).toEqual([])
    },
    S7_TIMEOUT_MS,
  )
})
