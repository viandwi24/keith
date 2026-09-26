// S-8 "Terminal first, visuals later" (docs/concept/scenarios.md), in a real browser.
//
// Keith runs with a TUI-like protocol node (`chat.text@1` only). A turn calls `weather.current`
// (the real `@keith/tool-weather` with a fake `fetch`). Then the built `@keith/web` app, loaded by
// package name like any configured plugin, is opened in Chromium: it signs in, shows the same
// Thread with the weather card from history, and its Refresh button (`ui.action` → the tool's
// `onAction`) adds an updated card. The TUI node gets the same text and the card's fallback, and
// never a `ui.render` frame. Nothing in the Mind or the tool knows about the browser (I-9, I-12).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'
import { type MessageDto, type UiBlock, uiBlockToText } from '../../packages/protocol/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import { createWeatherPlugin, type FetchLike } from '../../plugins/tool-weather/src/index.ts'
import { type BuiltWebApp, buildWebApp, launchChromium } from './browser.ts'
import {
  addPerson,
  connectNode,
  createHome,
  e2eClock,
  e2eConfig,
  scriptedLlm,
  scriptedProvider,
  startKeith,
  WAIT_MS,
} from './harness.ts'

/** Browser steps get more time than protocol frames: the page loads and renders. */
const UI_WAIT_MS = 10_000
const S8_TIMEOUT_MS = 60_000

const QUESTION = "What's the weather in Surabaya?"
const ANSWER = "It's 27.6°C and clear in Surabaya, sir. No rain in the next hours."

let web: BuiltWebApp
let browser: Browser

beforeAll(async () => {
  web = await buildWebApp()
  browser = await launchChromium()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await web?.remove()
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

// A fake Open-Meteo: geocoding finds Surabaya; each forecast call returns the next temperature.

type Weather = { temperature: number; code: number }

function forecastBody(w: Weather) {
  const hours = Array.from({ length: 12 }, (_, i) => `2026-09-27T${String(9 + i).padStart(2, '0')}:00`)
  return {
    timezone: 'Asia/Jakarta',
    current: {
      time: '2026-09-27T09:15',
      temperature_2m: w.temperature,
      relative_humidity_2m: 70,
      apparent_temperature: w.temperature + 2,
      precipitation: 0,
      weather_code: w.code,
      wind_speed_10m: 11.2,
    },
    hourly: {
      time: hours,
      precipitation_probability: hours.map(() => 5),
      precipitation: hours.map(() => 0),
      weather_code: hours.map(() => w.code),
    },
  }
}

function fakeOpenMeteo(forecasts: Weather[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  let next = 0
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  return {
    calls,
    async fetch(url) {
      calls.push(url)
      if (new URL(url).hostname.startsWith('geocoding')) {
        return json({
          results: [
            {
              name: 'Surabaya',
              latitude: -7.25,
              longitude: 112.75,
              country: 'Indonesia',
              timezone: 'Asia/Jakarta',
            },
          ],
        })
      }
      const w = forecasts[Math.min(next, forecasts.length - 1)]
      next += 1
      return json(forecastBody(w ?? { temperature: 0, code: 0 }))
    },
  }
}

type UiRenderFrame = { messageId?: string; block: UiBlock; fallbackText: string }

/** Records the `ui.render` frames the page's WebSocket receives. */
function recordUiRender(page: Page): UiRenderFrame[] {
  const frames: UiRenderFrame[] = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload)) as { type: string; data: UiRenderFrame }
      if (frame.type === 'ui.render') frames.push(frame.data)
    })
  })
  return frames
}

/** The card block of a message, from the DTO the TUI node received. */
function cardOf(message: MessageDto): UiBlock {
  const block = message.ui?.[0]
  if (!block) throw new Error(`message ${message.id} has no UI block`)
  return block
}

describe('S-8 terminal first, visuals later', () => {
  test(
    'the web app shows the TUI thread with the weather card, and Refresh updates it',
    async () => {
      // 1. Keith with the web plugin (by package name) and the weather tool; the TUI node only.
      const home = await createHome(
        e2eConfig({
          enabled: ['@keith/web'],
          extra: `[plugins."@keith/web"]\ndistDir = ${JSON.stringify(web.dir)}\n`,
        }),
      )
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const chat = scriptedLlm([[fakeToolCall('weather.current', { city: 'Surabaya' })], fakeText(ANSWER)])
      const meteo = fakeOpenMeteo([
        { temperature: 27.6, code: 0 },
        { temperature: 24.1, code: 3 },
      ])
      const { keith } = await startKeith({
        home,
        provider: scriptedProvider({ chat: { llm: chat } }),
        clock,
        plugins: [createWeatherPlugin({ fetch: meteo.fetch })],
      })
      cleanups.push(() => keith.stop())
      const states = keith.plugins.status().map((p) => [p.id, p.state])
      expect(states).toContainEqual(['@keith/web', 'started'])
      expect(states).toContainEqual(['@keith/tool-weather', 'started'])

      const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })
      const tui = await connectNode(keith, tony, { capabilities: ['chat.text@1'] })
      cleanups.push(() => tui.close())

      // 2. A TUI-driven turn: the model calls weather.current and answers.
      const { threadId } = await tui.openMain()
      tui.say(threadId, QUESTION)
      const answer = await tui.reply(threadId)
      expect(answer.content).toBe(ANSWER)
      const firstCard = cardOf(answer)
      expect(firstCard).toMatchObject({ type: 'card', id: 'weather', title: 'Surabaya' })
      expect(meteo.calls.filter((u) => u.includes('/v1/forecast'))).toHaveLength(1)

      // 3. The browser: sign in and see the same thread, card included, from history.
      const context = await browser.newContext()
      cleanups.push(() => context.close())
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (e) => pageErrors.push(String(e)))
      const uiRenders = recordUiRender(page)

      await page.goto(`${keith.url}/`)
      await page.getByLabel('Username').fill(tony.username)
      await page.getByLabel('Password').fill(tony.password)
      await page.getByRole('button', { name: 'Sign in' }).click()

      const timeline = page.locator('[data-slot="timeline"]')
      await timeline.getByText(QUESTION).waitFor({ timeout: UI_WAIT_MS })
      // I-7: the browser shows the same reply text the TUI got.
      const reply = page.locator(`[data-slot="message"][data-message-id="${answer.id}"]`)
      await reply.getByText(ANSWER).waitFor({ timeout: UI_WAIT_MS })
      const historyCard = reply.locator('[data-slot="ui-block"][data-block-id="weather"]')
      await historyCard.waitFor({ timeout: UI_WAIT_MS })
      expect(await historyCard.innerText()).toContain('Surabaya')
      expect(await historyCard.innerText()).toContain('27.6°C')
      // Tool steps of the turn (assistant rows without text or blocks) are not shown.
      expect(await page.locator('[data-slot="message"][data-role="assistant"]').count()).toBe(1)

      // 4. Refresh: ui.action → weather.current's onAction → a new message with an updated card.
      await historyCard.getByRole('button', { name: 'Refresh' }).click()
      const refreshed = await tui.reply(threadId)
      expect(refreshed.id).not.toBe(answer.id)
      expect(refreshed.content).toContain('24.1°C')
      const secondCard = cardOf(refreshed)
      expect(secondCard).toMatchObject({ type: 'card', id: 'weather', title: 'Surabaya' })

      const updated = page.locator(`[data-slot="message"][data-message-id="${refreshed.id}"]`)
      const updatedCard = updated.locator('[data-slot="ui-block"][data-block-id="weather"]')
      await updatedCard.waitFor({ timeout: UI_WAIT_MS })
      expect(await updatedCard.innerText()).toContain('24.1°C')
      expect(await updatedCard.innerText()).toContain('overcast')
      // I-7: the same text on both nodes.
      expect(await updated.innerText()).toContain(refreshed.content)
      // The refresh ran the tool again, not the model.
      expect(meteo.calls.filter((u) => u.includes('/v1/forecast'))).toHaveLength(2)
      expect(chat.requests).toHaveLength(2)

      // 5. The browser got the card as ui.render with its fallbackText; the TUI never did, and its
      //    client derives the same fallback from the message's blocks.
      const render = uiRenders.find((f) => f.messageId === refreshed.id)
      expect(render?.block).toEqual(secondCard)
      expect(render?.fallbackText).toBe(uiBlockToText(secondCard))
      expect(render?.fallbackText).toContain('24.1°C')
      expect(tui.frames.some((f) => f.type === 'ui.render')).toBe(false)
      const started = await tui.next('message.started', (f) => f.data.messageId === refreshed.id, WAIT_MS)
      expect(started.data.proactive).toBe(false)

      expect(pageErrors).toEqual([])
    },
    S8_TIMEOUT_MS,
  )
})
