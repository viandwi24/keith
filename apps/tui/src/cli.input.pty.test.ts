import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { UIMessage } from 'ai'
import { launch, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'
const TEST_TIMEOUT = 90_000
const ESC = String.fromCharCode(27)
const ON = `${ESC}[?1000h${ESC}[?1006h`
const OFF_1000 = `${ESC}[?1000l`
const OFF_1006 = `${ESC}[?1006l`
const WHEEL_UP = `${ESC}[<64;10;5M`
const WHEEL_DOWN = `${ESC}[<65;10;5M`

const history = (): UIMessage[] =>
  Array.from({ length: 60 }, (_, i) => ({
    id: `a${i}`,
    role: 'assistant',
    parts: [{ type: 'text', text: `answer ${i}` }],
  })) as UIMessage[]

afterEach(stopPty)

/** Mouse mode must be switched on at start and off again, whichever way the app ends. */
const switchedOff = (raw: string): boolean => {
  const on = raw.lastIndexOf(ON)
  return on >= 0 && raw.lastIndexOf(OFF_1000) > on && raw.lastIndexOf(OFF_1006) > on
}

describe.skipIf(!ptySupported)('mouse and keys in a real pseudo-terminal', () => {
  test(
    'the wheel scrolls the conversation three lines a notch; the wheel and the keys do not leak into the input',
    async () => {
      const { cli: app } = await launch({ history: history() }, ['answer 59'])
      expect(app.raw()).toContain(ON)
      const before = app.screen()
      expect(before).toContain('answer 59')
      expect(before).not.toContain('latest [end]')
      const write = (text: string) => app.proc.terminal?.write(text)
      // a wheel sent right after start can beat Ink's input handler: repeat until the view moved
      for (let i = 0; i < 10 && app.screen().includes('answer 59'); i++) {
        write(WHEEL_UP)
        await Bun.sleep(300)
      }
      await until(
        () => !app.screen().includes('answer 59'),
        10_000,
        'the view to scroll up',
        app.screen,
      )
      expect(app.screen()).toContain('↓ latest [end]')
      expect(app.screen()).not.toMatch(/\[<6/) // nothing of the report was typed
      for (let i = 0; i < 40 && !app.screen().includes('answer 59'); i++) {
        write(WHEEL_DOWN)
        await Bun.sleep(100)
      }
      await until(
        () => app.screen().includes('answer 59'),
        10_000,
        'the view back at the end',
        app.screen,
      )
      expect(app.screen()).not.toContain('latest [end]')
      // the input still takes keys after all that
      write('hi')
      await until(() => /\n\s+hi\s*(│.*)?\n/.test(app.screen()), 10_000, 'typing', app.screen)
    },
    TEST_TIMEOUT,
  )

  test(
    'shift+enter adds a newline, and the hint then names shift+enter instead of ctrl+j',
    async () => {
      const { cli: app } = await launch({}, [])
      expect(app.screen()).toContain('[ctrl+j] newline') // nothing proves the Kitty protocol yet
      const write = (text: string) => app.proc.terminal?.write(text)
      write('a')
      await until(() => /\n\s+a\s*(│.*)?\n/.test(app.screen()), 10_000, 'typing', app.screen)
      write(`${ESC}[13;2u`)
      await until(
        () => app.screen().includes('[shift+enter] newline'),
        10_000,
        'the hint to follow the first shift+enter',
        app.screen,
      )
      expect(app.screen()).not.toContain('[ctrl+j] newline')
      write('b')
      await until(
        () =>
          app
            .screen()
            .split('\n')
            .some((l) => /^\s+b\s*(│.*)?$/.test(l)),
        10_000,
        'the second line',
        app.screen,
      )
    },
    TEST_TIMEOUT,
  )

  test(
    'ctrl+c quits and leaves mouse mode off',
    async () => {
      const { cli: app } = await launch({}, [])
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
      expect(switchedOff(app.raw())).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    'a termination signal leaves mouse mode off',
    async () => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const { cli: app } = await launch({}, [])
        app.proc.kill(signal)
        await app.proc.exited
        expect(switchedOff(app.raw())).toBe(true)
        await stopPty()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    'an uncaught error leaves mouse mode off',
    async () => {
      let raw = ''
      const decoder = new TextDecoder()
      const proc = Bun.spawn(['bun', join(import.meta.dir, 'testing', 'mouse-crash.ts')], {
        terminal: {
          cols: 80,
          rows: 24,
          data: (_t, data) => (raw += decoder.decode(data, { stream: true })),
        },
      })
      expect(await proc.exited).not.toBe(0)
      expect(raw).toContain(ON)
      expect(switchedOff(raw)).toBe(true)
    },
    TEST_TIMEOUT,
  )
})
