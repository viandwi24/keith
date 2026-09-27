// The built web app in headless Chromium with a fake microphone (`--use-fake-device-for-media-stream`
// plays a test tone): opening the mic streams AudioWorklet-captured PCM16 to the fake core over
// the WebSocket, and the core's audio plays until `audio.stop`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type FakeCore, startFakeCore, waitUntil } from '@keith/client/testing'
import type { Browser, Page } from 'playwright'
import { type BuiltWebApp, buildWebApp, chromiumExecutable, launchChromium } from './browser.ts'

const UI_WAIT_MS = 10_000
const hasBrowser = chromiumExecutable() !== null

let web: BuiltWebApp
let browser: Browser
let core: FakeCore

beforeAll(async () => {
  if (!hasBrowser) return
  web = await buildWebApp()
  core = startFakeCore({ serve: (req) => web.serve(req) })
  browser = await launchChromium({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await core?.stop()
  await web?.remove()
})

async function signIn(page: Page) {
  await page.goto(core.url)
  await page.fill('input[name="username"]', 'tony')
  await page.fill('input[name="password"]', 'jarvis')
  await page.click('button[type="submit"]')
  await page.waitForSelector('textarea[placeholder="Message Keith"]', { timeout: UI_WAIT_MS })
}

describe.skipIf(!hasBrowser)('web voice in Chromium', () => {
  test('the mic sends 20 ms PCM16 binary frames over the WebSocket; audio.stop ends playback', async () => {
    const context = await browser.newContext()
    await context.grantPermissions(['microphone'], { origin: core.url })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const sentBinary: number[] = []
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') sentBinary.push(payload.byteLength)
      })
    })
    try {
      await signIn(page)
      const hello = core.received.findLast((f) => f.type === 'hello')
      expect(hello?.type === 'hello' ? hello.data.capabilities : []).toEqual([
        'chat.text@1',
        'ui.render@1',
        'audio.in@1',
        'audio.out@1',
      ])

      const before = core.receivedAudio.length
      await page.click('[data-slot="mic-toggle"]')
      await page.waitForSelector('[data-slot="mic-toggle"][data-state="on"]', { timeout: UI_WAIT_MS })
      // 1.5 s: Chromium's fake device beeps about once a second, with silence in between.
      await waitUntil(() => core.receivedAudio.length - before >= 75, UI_WAIT_MS, '75 audio frames')

      const start = core.received.findLast((f) => f.type === 'audio.start')
      if (start?.type !== 'audio.start') throw new Error('no audio.start')
      expect(start.data).toMatchObject({ threadId: core.thread.id, codec: 'pcm16', sampleRate: 16_000 })
      const frames = core.receivedAudio.slice(before)
      expect(frames.every((f) => f.kind === 1 && f.streamId === start.data.streamId)).toBe(true)
      expect(frames.map((f) => f.sequence)).toEqual(frames.map((_, i) => i))
      // 20 ms at 16 kHz: 320 samples, 640 bytes, plus the 21-byte header on the wire.
      expect(frames.every((f) => f.payload.byteLength === 640)).toBe(true)
      expect(sentBinary.slice(0, 3)).toEqual([661, 661, 661])
      // The fake device beeps, so the samples are not all silence.
      const samples = frames.flatMap((f) => [...new Int16Array(f.payload.buffer, 0, 320)])
      expect(samples.some((s) => Math.abs(s) > 100)).toBe(true)

      await page.click('[data-slot="mic-toggle"]')
      await waitUntil(
        () => core.received.some((f) => f.type === 'audio.end' && f.data.streamId === start.data.streamId),
        UI_WAIT_MS,
        'audio.end',
      )

      // Two seconds of core audio: the speaking indicator shows until audio.stop cuts it.
      const chunks = Array.from({ length: 20 }, () =>
        Int16Array.from({ length: 2400 }, (_, i) => Math.round(8000 * Math.sin(i / 5))),
      )
      const streamId = core.pushAudio({ chunks, sampleRate: 24_000, end: false })
      await page.waitForSelector('[data-slot="speaking"][data-playing="true"]', {
        state: 'attached',
        timeout: UI_WAIT_MS,
      })
      core.stopAudio(streamId)
      await page.waitForSelector('[data-slot="speaking"][data-playing="false"]', {
        state: 'attached',
        timeout: 1_000,
      })
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 60_000)
})
