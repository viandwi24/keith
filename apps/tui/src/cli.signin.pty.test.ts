import { afterEach, describe, expect, test } from 'bun:test'
import { type Cli, launch, pressUntil, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

const ENTER = '\r'
const TAB = '\t'
const ESC = '\u001b'
const WHO = 'id, username, email or phone'
// built at runtime: fake secrets, never literals
const PIN = ['4', '8', '1', '5', '9', '2'].join('')
const PASSWORD = `${'pw'}-${'q7'.repeat(5)}`

/** A signed-out Home on a fake core: the login panel is up and asks who. */
const signedOut = (flow: NonNullable<Parameters<typeof launch>[0]['flow']>) =>
  launch({ revoked: true, flow }, [WHO], 100, undefined, [])

/** Type `who` in the box and send it; the methods follow. */
async function identify(app: Cli, who: string): Promise<void> {
  // the field takes keys once it is mounted
  await Bun.sleep(300)
  app.proc.terminal?.write(who)
  await until(() => app.screen().includes(who), 20_000, 'the typed identifier', app.screen)
  app.proc.terminal?.write(ENTER)
}

/** Type a secret, check it is masked, send it. */
async function secret(app: Cli, text: string, count: number): Promise<void> {
  await until(
    () => app.screen().includes('[enter] sign in'),
    20_000,
    'the secret field',
    app.screen,
  )
  await Bun.sleep(300)
  app.proc.terminal?.write(text)
  await until(
    () => app.screen().includes('•'.repeat(count)),
    20_000,
    'the masked secret',
    app.screen,
  )
  expect(app.screen()).not.toContain(text)
  app.proc.terminal?.write(ENTER)
}

describe.skipIf(!ptySupported)('the login panel of Home, in a real pseudo-terminal', () => {
  test(
    'identify, the PIN the core marked default, then Home signed in; the PIN never reaches the terminal',
    async () => {
      const { cli: app, core } = await signedOut({ people: { owner: { pin: PIN } } })
      expect(app.screen()).toContain('Sign in')
      expect(app.screen()).toContain('K E I T H')
      await identify(app, 'owner')
      await until(() => app.screen().includes('[PIN]'), 20_000, 'the PIN method', app.screen)
      expect(app.screen()).not.toContain('plain HTTP')
      await secret(app, PIN, PIN.length)
      await until(
        () => app.screen().includes('[enter] chat') && app.screen().includes('signed in as Owner'),
        30_000,
        'Home signed in',
        app.screen,
      )
      expect(core.identified).toEqual(['owner'])
      expect(core.flowAnswers).toEqual([{ identifier: 'owner', method: 'pin' }])
      expect(Bun.stripANSI(app.raw())).not.toContain(PIN)
      expect(app.raw()).not.toContain(PIN)
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )

  test(
    'where the core refuses the PIN the password is shown, and signs in',
    async () => {
      const { cli: app, core } = await signedOut({
        context: 'public',
        pin: false,
        people: { owner: { password: PASSWORD } },
      })
      await identify(app, 'owner')
      await until(() => app.screen().includes('[Password]'), 20_000, 'the password', app.screen)
      expect(app.screen()).toContain('! PIN')
      await secret(app, PASSWORD, PASSWORD.length)
      await until(
        () => app.screen().includes('[enter] chat') && app.screen().includes('signed in as Owner'),
        30_000,
        'Home signed in',
        app.screen,
      )
      expect(core.flowAnswers).toEqual([{ identifier: 'owner', method: 'password' }])
      expect(Bun.stripANSI(app.raw())).not.toContain(PASSWORD)
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )

  test(
    'the plain-HTTP warning is visible on the lan and absent on loopback',
    async () => {
      const lan = await signedOut({ context: 'lan', people: { owner: { pin: PIN } } })
      await identify(lan.cli, 'owner')
      await until(
        () => lan.cli.screen().includes('plain HTTP on this'),
        20_000,
        'the lan warning',
        lan.cli.screen,
      )
      expect(lan.cli.screen()).toContain('[PIN]')
      await stopPty()
      const local = await signedOut({ context: 'loopback', people: { owner: { pin: PIN } } })
      await identify(local.cli, 'owner')
      await until(() => local.cli.screen().includes('[PIN]'), 20_000, 'the PIN', local.cli.screen)
      await Bun.sleep(300)
      expect(local.cli.screen()).not.toContain('plain HTTP')
    },
    TEST_TIMEOUT,
  )

  test(
    'esc goes back one step and keeps the identifier; a made-up name gets the same panel and the same failure',
    async () => {
      const { cli: app, core } = await signedOut({ people: { owner: { pin: '999999' } } })
      await identify(app, 'nobody')
      await until(() => app.screen().includes('[PIN]'), 20_000, 'the PIN method', app.screen)
      // the unknown identifier gets the same methods; esc returns to the box with it filled
      await pressUntil(
        { proc: app.proc, screen: app.screen },
        ESC,
        (s) => s.includes('nobody') && s.includes('[enter] next') && !s.includes('[PIN]'),
        'the box again',
      )
      app.proc.terminal?.write(ENTER)
      await until(() => app.screen().includes('[PIN]'), 20_000, 'the PIN again', app.screen)
      await secret(app, PIN, PIN.length)
      await until(
        () => app.screen().includes('sign-in failed: check your id and'),
        20_000,
        'the uniform failure',
        app.screen,
      )
      expect(core.identified).toEqual(['nobody', 'nobody'])
      // tab still switches methods after a failure
      app.proc.terminal?.write(TAB)
      await until(() => app.screen().includes('[Password]'), 20_000, 'the password tab', app.screen)
      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )
})
