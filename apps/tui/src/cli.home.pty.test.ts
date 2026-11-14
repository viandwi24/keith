import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { launch, pressUntil, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

/** The brain frame's top border carries the orb mode word as its status tag. */
const FRAME_TAG = /╭─ idle/

describe.skipIf(!ptySupported)('keith opens Home in a real pseudo-terminal', () => {
  test(
    'Home shows the title and keys; space opens the menu, esc closes it, enter opens the chat, esc returns',
    async () => {
      const { cli: app } = await launch(
        { rpc: createFakeAdmin().rpc },
        ['K E I T H', '[enter] chat', '[space] menu'],
        100,
        undefined,
        [],
      )
      expect(app.screen()).not.toContain('type a message')

      await pressUntil(app, ' ', (s) => s.includes('Overview'), 'the menu')
      await pressUntil(
        app,
        '\u001b',
        (s) => !s.includes('Overview') && s.includes('[space] menu'),
        'the menu closed',
      )

      await pressUntil(app, '\r', (s) => s.includes('type a message'), 'the chat')
      await pressUntil(
        app,
        '\u001b',
        (s) => s.includes('[enter] chat') && !s.includes('type a message'),
        'Home after esc',
      )

      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
      const esc = String.fromCharCode(27)
      expect(app.raw()).toContain(`${esc}[?1049h`)
      expect(app.raw()).toContain(`${esc}[?1049l`)
    },
    TEST_TIMEOUT,
  )

  test(
    'the brain frame is hidden at 79 columns and shown at 120',
    async () => {
      const narrow = await launch({}, ['K E I T H', '[enter] chat'], 79, undefined, [])
      await until(
        () => narrow.cli.screen().includes('idle'),
        20_000,
        'the mode word',
        narrow.cli.screen,
      )
      expect(narrow.cli.screen()).not.toMatch(FRAME_TAG)
      await stopPty()

      const wide = await launch({}, ['K E I T H', '[enter] chat'], 120, undefined, [])
      await until(
        () => FRAME_TAG.test(wide.cli.screen()),
        20_000,
        'the brain frame',
        wide.cli.screen,
      )
    },
    TEST_TIMEOUT,
  )
})
