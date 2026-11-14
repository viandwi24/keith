import { afterEach, describe, expect, test } from 'bun:test'
import { chatReady, frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const ESC = '\u001b'
const CTRL_G = '\u0007'
/** A long answer: the fake core streams a word every few ms, so the turn runs for seconds. */
const LONG = `${Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ')} theend`

const startTurn = async (options: Parameters<typeof setupApp>[0] = {}) => {
  const view = await setupApp({ columns: 100, rows: 30, reply: LONG, ...options })
  await chatReady(view.lastFrame)
  await typeLine(view.stdin, 'hello')
  await frameUntil(view.lastFrame, (f) => f.includes('[esc] stop'))
  return view
}

describe('leaving the chat never stops a turn', () => {
  test('ctrl+g mid-turn goes Home, the turn keeps going, and the answer is whole in the chat', async () => {
    const { lastFrame, stdin, unmount } = await startTurn()
    await pressUntil(stdin, lastFrame, CTRL_G, (f) => f.includes('K E I T H'))
    // Home while a turn runs: the legend offers stop
    const home = await frameUntil(lastFrame, (f) => f.includes('[esc] stop'))
    expect(home).toContain('[enter] chat')
    expect(home).toContain('[space] menu')
    expect(home).toMatch(/● (thinking|speaking)/)
    // it ends by itself, nothing stopped it
    await frameUntil(lastFrame, (f) => !f.includes('[esc] stop'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('type a message'))
    const chat = await frameUntil(lastFrame, (f) => f.includes('theend'))
    expect(chat).not.toContain('■ stopped')
    unmount()
  })

  test('esc while a turn runs stops it and nothing else: the chat stays', async () => {
    const { lastFrame, stdin, unmount } = await startTurn()
    await pressUntil(stdin, lastFrame, ESC, (f) => !f.includes('[esc] stop'))
    await Bun.sleep(300)
    const f = lastFrame() ?? ''
    expect(f).not.toContain('K E I T H')
    expect(f).toContain('KEITH')
    expect(f).not.toContain('theend')
    unmount()
  })

  test('esc when idle goes Home', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ columns: 100, rows: 30 })
    await chatReady(lastFrame)
    await pressUntil(stdin, lastFrame, ESC, (f) => f.includes('K E I T H'))
    unmount()
  })

  test('on Home esc stops the running turn, with nothing else; idle Home ignores esc', async () => {
    const { lastFrame, stdin, unmount } = await startTurn()
    await pressUntil(stdin, lastFrame, CTRL_G, (f) => f.includes('K E I T H'))
    await frameUntil(lastFrame, (f) => f.includes('[esc] stop'))
    await pressUntil(stdin, lastFrame, ESC, (f) => !f.includes('[esc] stop'))
    const f = lastFrame() ?? ''
    expect(f).toContain('K E I T H') // still Home
    expect(f).toContain('[enter] chat')
    stdin.write(ESC)
    await Bun.sleep(150)
    expect(lastFrame()).toContain('K E I T H')
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('type a message'))
    await Bun.sleep(300)
    expect(lastFrame()).not.toContain('theend')
    unmount()
  })

  test('ctrl+g when idle goes Home too', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ columns: 100, rows: 30 })
    await chatReady(lastFrame)
    await pressUntil(stdin, lastFrame, CTRL_G, (f) => f.includes('K E I T H'))
    expect(lastFrame()).not.toContain('[esc] stop')
    unmount()
  })
})
