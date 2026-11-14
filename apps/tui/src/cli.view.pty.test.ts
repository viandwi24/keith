import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { launch, pressUntil, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'
const TEST_TIMEOUT = 90_000
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

afterEach(stopPty)

/** What a hostile view prints: a clipboard write, a window title, a device report request, a cursor jump, and real text. */
const HOSTILE = [
  `${ESC}]52;c;aGVsbG8=${BEL}clip`,
  `${ESC}]0;pwned-title${BEL}title`,
  `${ESC}[6n${ESC}[2J${ESC}[1;1Hjump`,
  `${ESC}[31mred text${ESC}[0m and plain`,
  `${ESC}Pq#0;2;0;0;0${ESC}\\dcs ${ESC}_Gi=1;AAAA${ESC}\\apc`,
].join('\n')

describe.skipIf(!ptySupported)('a plugin view in a real pseudo-terminal', () => {
  test(
    'Home menu opens the view; a hostile frame never reaches the terminal; esc returns Home',
    async () => {
      const { cli: app, core } = await launch(
        {
          rpc: createFakeAdmin().rpc,
          views: {
            menu: [{ id: 'notes.browse', plugin: 'notes', label: 'Notes', viewId: 'notes.list' }],
            frame: () => HOSTILE,
          },
        },
        ['K E I T H', '[space] menu'],
        100,
        undefined,
        [],
      )
      await pressUntil(app, ' ', (s) => s.includes('Apps'), 'the menu')
      // the plugin entry lives in the Apps submenu: open it, then move to the entry
      for (let i = 0; i < 12 && !app.screen().includes('▸ Apps'); i++) {
        app.proc.terminal?.write('j')
        await Bun.sleep(60)
      }
      await pressUntil(app, '\r', (s) => s.includes('Notes'), 'the Apps submenu')
      for (let i = 0; i < 30 && !app.screen().includes('▸ Notes'); i++) {
        app.proc.terminal?.write('j')
        await Bun.sleep(60)
      }
      await pressUntil(
        app,
        '\r',
        (s) => s.includes('red text and plain'),
        'the view opened and its text is drawn',
      )
      const screen = app.screen()
      expect(screen).toContain('clip')
      expect(screen).toContain('title')
      expect(screen).toContain('[esc] back')
      // nothing of the hostile sequences reached the real terminal
      const raw = app.raw()
      for (const bad of [
        `${ESC}]52`,
        'aGVsbG8',
        'pwned-title',
        `${ESC}[6n`,
        `${ESC}Pq`,
        `${ESC}_G`,
        `${ESC}]0;`,
      ])
        expect(raw, bad).not.toContain(bad)
      expect(core.views?.hellos).toHaveLength(1)
      // a key reaches the view as terminal bytes; esc goes Home and closes the view
      app.proc.terminal?.write('x')
      await until(
        () => core.views?.keys.includes('x') === true,
        10_000,
        'the key at the view',
        app.screen,
      )
      await pressUntil(app, ESC, (s) => s.includes('[space] menu'), 'Home after esc')
      await until(() => core.views?.closes === 1, 10_000, 'the close at the core', app.screen)
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )
})
