import { afterEach, describe, expect, test } from 'bun:test'
import { resolveTheme } from '@keith/ui'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const COLOUR = resolveTheme({ theme: 'dark', depth: 'truecolor' })
const wait = (ms: number) => Bun.sleep(ms)

/** Home on a colour terminal, with the orb still (`orbStatic`) or moving. */
const home = (orbStatic: boolean) =>
  setupApp({
    start: 'home',
    columns: 120,
    rows: 40,
    theme: COLOUR,
    motion: { intro: false, idleHideSeconds: 0, reduced: false, orbStatic },
  })

describe('--disable-orb: the screens switch without the orb flying', () => {
  test('enter goes to the chat at once; ctrl+g goes back to Home at once', async () => {
    const { lastFrame, stdin, unmount } = await home(true)
    await frameUntil(lastFrame, (x) => x.includes('K E I T H'))
    // the flight takes 300 ms: a still orb has none, so the chat is on screen within 150 ms
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('type a message'), {
      timeoutMs: 150,
    })
    await pressUntil(stdin, lastFrame, '\u0007', (x) => x.includes('K E I T H'), { timeoutMs: 150 })
    unmount()
  })

  test('without the flag the orb still flies: the chat is not up within 150 ms', async () => {
    const { lastFrame, stdin, unmount } = await home(false)
    await frameUntil(lastFrame, (x) => x.includes('K E I T H'))
    stdin.write('\r')
    await wait(150)
    expect(lastFrame() ?? '').not.toContain('type a message')
    await frameUntil(lastFrame, (x) => x.includes('type a message'))
    unmount()
  })
})
