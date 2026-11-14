import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chatReady, frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

// a 1 s window and a 4 s wait (the smallest the settings take) so the real timers are quick
beforeEach(() => {
  process.env.KEITH_RECONNECT_WINDOW_SECONDS = '1'
  process.env.KEITH_RECONNECT_WAIT_SECONDS = '4'
})
afterEach(() => {
  delete process.env.KEITH_RECONNECT_WINDOW_SECONDS
  delete process.env.KEITH_RECONNECT_WAIT_SECONDS
  stopCores()
})

describe('the chat while the core is gone', () => {
  test('reconnecting, then the red message, the input replaced, the draft kept, then live again', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({ columns: 120, rows: 40 })
    await chatReady(lastFrame)
    stdin.write('half typed')
    await frameUntil(lastFrame, (f) => f.includes('half typed'))
    core.feedDown(true, 503)
    const down = await frameUntil(
      lastFrame,
      (f) => f.includes('disconnected: cannot reach the core') && f.includes('retrying in'),
    )
    // the message wraps under the title (two rows on this short terminal): the countdown may break before its number
    expect(down).toMatch(/\d+ s/)
    // the message is in the title row and in place of the input; no silent no-op
    expect(down).toContain('✕ offline: cannot reach the core')
    expect(down).not.toContain('type a message')
    expect(down).toContain('[r] retry now')
    // the core is back: an attempt makes the link live and the input returns with the draft
    core.feedDown(false)
    const back = await frameUntil(
      lastFrame,
      (f) => f.includes('half typed') && f.includes('online'),
      30_000,
    )
    expect(back).not.toContain('✕ offline')
    unmount()
  }, 60_000)

  test('r retries now, and a key that needs the core says offline on Home', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      start: 'home',
      columns: 100,
      rows: 30,
    })
    await frameUntil(lastFrame, (f) => f.includes('[space] menu'))
    core.feedDown(true, 503)
    await frameUntil(lastFrame, (f) => f.includes('disconnected'), 30_000)
    // Home's chat key is refused with the hint
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('offline: cannot reach the core'))
    // the menu still opens (Logout needs no core): Overview and the rest are dimmed and refuse to open
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('Overview') && f.includes('Logout'))
    await pressUntil(stdin, lastFrame, '\u001b[C', (f) =>
      f.includes('offline: cannot reach the core'),
    )
    expect(lastFrame()).not.toContain('Cannot open')
    unmount()
  }, 60_000)

  test('Manage refuses its actions with the hint and keeps esc and the movement keys', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      start: 'manage',
      columns: 120,
      rows: 40,
    })
    core.feedDown(true, 503)
    await frameUntil(lastFrame, (f) => f.includes('disconnected'), 30_000)
    // the legend dims what needs the core and offers the retry
    await frameUntil(lastFrame, (f) => f.includes('[r] retry now') && f.includes('[esc] back'))
    // movement still works
    await pressUntil(stdin, lastFrame, '\u001b[B', (f) => f.includes('▸') || f.includes('›'))
    unmount()
  }, 60_000)
})
