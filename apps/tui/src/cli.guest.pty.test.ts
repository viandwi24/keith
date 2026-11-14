import { afterEach, describe, expect, test } from 'bun:test'
import { launch, pressUntil, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

describe.skipIf(!ptySupported)('keith --guest in a real pseudo-terminal', () => {
  test(
    'chats anonymously against the guest listener with no login, and ctrl+c ends the session at the core',
    async () => {
      // a core that refuses every credential: guest chat must not need one
      const { cli: app, core } = await launch(
        { revoked: true, guest: { reply: 'Here is the public note.' } },
        ['anonymous'],
        100,
        undefined,
        ['--guest', '--core', '$CORE'],
      )
      expect(app.screen()).toContain('Guest')
      await until(
        () => app.screen().includes('20 of 20 messages left'),
        20_000,
        'the counters',
        app.screen,
      )
      // the input takes keys once it is mounted: write the message until it shows
      await Bun.sleep(300)
      app.proc.terminal?.write('what is public?')
      await until(
        () => app.screen().includes('what is public?'),
        20_000,
        'the typed message',
        app.screen,
      )
      await pressUntil(
        app,
        '\r',
        (s) => s.includes('Here is the public note.') && s.includes('19 of 20'),
        'the answer',
      )
      expect(core.guest.chats).toEqual(['what is public?'])
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
      // the session was ended at the core on the way out
      expect(core.guest.deleted).toBe(1)
      // nothing of an account was touched
      const touched = core.seen.filter((l) => !l.includes(' /guest/') && !l.includes('/health'))
      expect(touched).toEqual([])
      // the bearer is a runtime-built fake; it never reached the terminal
      expect(Bun.stripANSI(app.raw())).not.toContain('keith_g_')
    },
    TEST_TIMEOUT,
  )
})
