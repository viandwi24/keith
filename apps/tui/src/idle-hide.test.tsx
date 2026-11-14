import { afterEach, describe, expect, test } from 'bun:test'
import { stripAnsi } from './testing/ansi.ts'
import { frameUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

// hide after one second without a key: the timer runs in the test, not the process default of 60 s
const IDLE = { intro: false, idleHideSeconds: 1, reduced: false, orbStatic: false }

describe('the idle hide is Home only (A10, tui-design 5.16 Motion)', () => {
  test('control: Home hides its legend and title after the idle time', async () => {
    const { lastFrame, unmount } = await setupApp({ start: 'home', motion: IDLE })
    await frameUntil(lastFrame, (f) => stripAnsi(f).includes('[enter] chat'))
    await Bun.sleep(1800)
    const f = stripAnsi(lastFrame() ?? '')
    expect(f).not.toContain('[enter] chat')
    expect(f).not.toContain('K E I T H')
    unmount()
  })

  test('the chat keeps its content after the idle time', async () => {
    const { lastFrame, unmount } = await setupApp({ start: 'chat', motion: IDLE })
    await frameUntil(lastFrame, (f) => stripAnsi(f).includes('type a message'))
    await Bun.sleep(1800)
    expect(stripAnsi(lastFrame() ?? '')).toContain('type a message')
    unmount()
  })

  test('Manage keeps its content after the idle time', async () => {
    const { lastFrame, unmount } = await setupApp({ start: 'manage', motion: IDLE })
    await frameUntil(lastFrame, (f) => stripAnsi(f).includes('Manage'))
    const before = stripAnsi(lastFrame() ?? '')
    await Bun.sleep(1800)
    const after = stripAnsi(lastFrame() ?? '')
    expect(after).toContain('Manage')
    expect(after.trim().length).toBeGreaterThan(0)
    // the screen did not fade away: what was drawn is still drawn
    expect(after.split('\n').filter((l) => l.trim() !== '').length).toBe(
      before.split('\n').filter((l) => l.trim() !== '').length,
    )
    unmount()
  })
})
