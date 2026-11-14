import { afterEach, describe, expect, test } from 'bun:test'
import { launch, pressUntil, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

const ENTER = '\r'
// built at runtime: a fake secret, never a literal
const SECRET = `${'pw'}-${'q7'.repeat(5)}`

describe.skipIf(!ptySupported)('keith login in a real pseudo-terminal', () => {
  test(
    'opens the Sign in screen, identifies, signs in with a password inside the app and lands on Home',
    async () => {
      const { cli: app, core } = await launch(
        { auth: { password: { username: 'owner', password: SECRET } } },
        ['Which core do you want to sign in to?'],
        100,
        undefined,
        ['login', '--core', '$CORE'],
      )
      // the address step, then the one box (this fake core has no /auth/identify: an older core)
      await pressUntil(
        app,
        ENTER,
        (s) => s.includes('id, username, email or phone'),
        'the identifier box',
      )
      // the field takes keys once it is mounted: wait for its text, then type the name
      await Bun.sleep(300)
      app.proc.terminal?.write('owner')
      await until(() => /owner/.test(app.screen()), 20_000, 'the typed identifier', app.screen)
      app.proc.terminal?.write(ENTER)
      await until(
        () => app.screen().includes('[enter] sign in'),
        20_000,
        'the password field',
        app.screen,
      )
      await Bun.sleep(300)
      app.proc.terminal?.write(SECRET)
      await until(() => app.screen().includes('••••'), 20_000, 'the masked password', app.screen)
      expect(app.screen()).not.toContain(SECRET)
      app.proc.terminal?.write(ENTER)
      // the app goes on to Home on the new credential: no restart, no second command
      await until(
        () => app.screen().includes('[enter] chat') && app.screen().includes('K E I T H'),
        30_000,
        'Home after the sign in',
        app.screen,
      )
      expect(core.logins).toEqual([{ username: 'owner' }])
      // the secret never reached the terminal: not echoed, not drawn
      expect(Bun.stripANSI(app.raw())).not.toContain(SECRET)
      expect(app.raw()).not.toContain(SECRET)
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )
})
