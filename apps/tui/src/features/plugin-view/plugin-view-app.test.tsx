import { afterEach, describe, expect, test } from 'bun:test'
import { manualScheduler } from '@keith/ui/testing'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const ESC = '\u001b'
const MENU = [
  { id: 'notes.browse', plugin: 'notes', label: 'Notes', viewId: 'notes.list' },
  { id: 'reminders.list', plugin: 'reminders', label: 'Reminders', viewId: 'reminders.list' },
]
const home = (options: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({
    start: 'home',
    columns: 100,
    rows: 30,
    views: { menu: MENU, frame: (h) => `view ${h.viewId} ${h.cols}x${h.rows}` },
    ...options,
  })

/** Open the menu and the Apps submenu, where the plugin views are. */
async function openApps(stdin: { write(data: string): void }, lastFrame: () => string | undefined) {
  const f = await pressUntil(stdin, lastFrame, ' ', (x) => x.includes('Apps'))
  for (let i = 0; i < 12 && !(lastFrame() ?? '').includes('▸ Apps'); i++) {
    stdin.write('j')
    await Bun.sleep(40)
  }
  await frameUntil(lastFrame, (x) => x.includes('▸ Apps'))
  stdin.write('\r')
  return f
}

/** Open the menu and select the entry whose row says `label`. */
async function openEntry(
  stdin: { write(data: string): void },
  lastFrame: () => string | undefined,
  label: string,
) {
  await openApps(stdin, lastFrame)
  for (let i = 0; i < 30 && !(lastFrame() ?? '').includes(`▸ ${label}`); i++) {
    stdin.write('j')
    await Bun.sleep(40)
  }
  await frameUntil(lastFrame, (f) => f.includes(`▸ ${label}`))
  await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('[esc] back'))
}

describe('plugin views from Home', () => {
  test('the Apps submenu lists the entries the core sent, then Plugins and Reviews', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await openApps(stdin, lastFrame)
    const f = await frameUntil(lastFrame, (x) => x.includes('Reminders'))
    expect(f).toContain('Notes')
    expect(f.indexOf('Reminders')).toBeLessThan(f.indexOf('Plugins'))
    expect(f.indexOf('Plugins')).toBeLessThan(f.indexOf('Reviews'))
    expect(f).not.toContain('Help')
    unmount()
  })

  test('a core with no plugin views lists no plugin entries', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ start: 'home', columns: 100, rows: 30 })
    const f = await pressUntil(stdin, lastFrame, ' ', (x) => x.includes('▸ Overview'))
    expect(f).not.toContain('Notes')
    expect(f).not.toContain('Reminders')
    unmount()
  })

  test('enter opens the view over a real WebSocket, keys reach it, esc returns Home and closes it', async () => {
    const { lastFrame, stdin, core, unmount } = await home()
    await openEntry(stdin, lastFrame, 'Notes')
    const f = await frameUntil(lastFrame, (x) => x.includes('view notes.list'))
    expect(f).toContain('Notes') // the label tag
    // 100 columns less the margins; 30 rows less the frame's 6
    expect(core.views?.hellos[0]).toMatchObject({ viewId: 'notes.list', cols: 96, rows: 24 })
    expect(core.views?.auth[0]).toBe('Bearer t')
    stdin.write('q')
    await frameUntil(lastFrame, (x) => x.includes('keys ["q"]'))
    await pressUntil(stdin, lastFrame, ESC, (x) => x.includes('[space] menu'))
    for (let i = 0; i < 100 && core.views?.closes !== 1; i++) await Bun.sleep(20)
    expect(core.views?.closes).toBe(1)
    unmount()
  })

  test('ctrl+g from a view goes Home too', async () => {
    const { lastFrame, stdin, core, unmount } = await home()
    await openEntry(stdin, lastFrame, 'Reminders')
    await frameUntil(lastFrame, (x) => x.includes('view reminders.list'))
    await pressUntil(stdin, lastFrame, '\u0007', (x) => x.includes('[space] menu'))
    expect(core.views?.keys).toEqual([])
    unmount()
  })

  test('the core going away says disconnected and esc returns', async () => {
    const { lastFrame, stdin, core, unmount } = await home()
    await openEntry(stdin, lastFrame, 'Notes')
    await frameUntil(lastFrame, (x) => x.includes('view notes.list'))
    core.views?.drop()
    await frameUntil(lastFrame, (x) => x.includes('Disconnected from the core.'))
    await pressUntil(stdin, lastFrame, ESC, (x) => x.includes('[space] menu'))
    unmount()
  })

  test('a view keeps Home from hiding; Home is whole again after it', async () => {
    const scheduler = manualScheduler()
    const { lastFrame, stdin, unmount } = await home({
      scheduler,
      motion: { intro: false, idleHideSeconds: 5, reduced: false, orbStatic: false },
    })
    await openEntry(stdin, lastFrame, 'Notes')
    await frameUntil(lastFrame, (x) => x.includes('view notes.list'))
    // a minute in the view: Home is not mounted, so no veil runs under it
    scheduler.advance(60_000)
    await Bun.sleep(50)
    expect(lastFrame()).toContain('view notes.list')
    await pressUntil(stdin, lastFrame, ESC, (x) => x.includes('[space] menu'))
    expect(lastFrame()).toContain('K E I T H')
    unmount()
  })
})
