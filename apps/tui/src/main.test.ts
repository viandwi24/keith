import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { INVITE_INVALID_MESSAGE } from '@keith/client'
import { FAKE_INVITE_CODE, startFakeCore, waitUntil } from '@keith/client/testing'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import { tempConfigHome } from '../test/helpers.ts'
import { loadSession, sessionFilePath } from './config.ts'
import { TuiError } from './errors.ts'
import { main, parseArgs, USAGE } from './main.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const none = { url: undefined, invite: undefined, help: false, logout: false }

describe('keith-tui arguments', () => {
  test('--url in both forms', () => {
    expect(parseArgs(['--url', 'http://h:1'])).toEqual({ ...none, url: 'http://h:1' })
    expect(parseArgs(['--url=http://h:2'])).toEqual({ ...none, url: 'http://h:2' })
    expect(parseArgs([])).toEqual(none)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  test('--logout', () => {
    expect(parseArgs(['--logout'])).toEqual({ ...none, logout: true })
  })

  test('--invite in both forms, with --url', () => {
    expect(parseArgs(['--url', 'http://h:1', '--invite', 'abc'])).toEqual({
      ...none,
      url: 'http://h:1',
      invite: 'abc',
    })
    expect(parseArgs(['--invite=abc']).invite).toBe('abc')
  })

  test('rejects unknown arguments and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(TuiError)
    expect(() => parseArgs(['--url'])).toThrow('--url needs a value')
    expect(() => parseArgs(['--invite'])).toThrow('--invite needs a value')
    expect(() => parseArgs(['--invite='])).toThrow('--invite needs a value')
    expect(() => parseArgs(['--invite', '--url', 'http://h:1'])).toThrow('--invite needs a value')
    expect(() => parseArgs(['--invite', 'abc', '--logout'])).toThrow('cannot be combined')
  })

  test('--invite without a value exits 2, and --help lists the flag and the thread commands', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    cleanups.push(() => {
      errors.mockRestore()
      logs.mockRestore()
    })
    expect(await main(['--invite'], {})).toBe(2)
    expect(errors).toHaveBeenCalledWith('--invite needs a value')
    expect(await main(['--help'], {})).toBe(0)
    expect(logs).toHaveBeenCalledWith(USAGE)
    expect(USAGE).toContain('--invite <code>')
    expect(USAGE).toContain('/threads')
    expect(USAGE).toContain('/open <n>')
  })
})

/** Renders until a frame matches: `main` mounts its screens after async work, unlike `waitForFrame`'s few passes. */
async function frameWith(setup: TestRendererSetup, predicate: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000
  for (;;) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() > deadline) throw new Error(`timed out waiting for a frame; last:\n${frame}`)
    await Bun.sleep(10)
  }
}

describe('keith-tui --invite', () => {
  async function start(code: string) {
    const core = startFakeCore()
    cleanups.push(() => core.stop())
    const home = await tempConfigHome()
    cleanups.push(home.cleanup)
    const setup: TestRendererSetup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false })
    cleanups.push(() => setup.renderer.destroy())
    const env = { XDG_CONFIG_HOME: home.dir }
    const exit = main(['--url', core.url, '--invite', code], env, {
      createRenderer: async () => setup.renderer,
    })
    await frameWith(setup, (f) => f.includes('sign up with your invite'))
    return { core, setup, env, exit }
  }

  async function fillForm(setup: TestRendererSetup, username: string, password: string) {
    await setup.mockInput.typeText(username)
    setup.mockInput.pressEnter()
    await setup.mockInput.typeText(password)
    setup.mockInput.pressEnter()
    await setup.mockInput.typeText(password)
    setup.mockInput.pressEnter()
  }

  test('a sign-up stores the session and opens Main', async () => {
    const { core, setup, env, exit } = await start(FAKE_INVITE_CODE)
    await fillForm(setup, 'pepper', 'potts-1234')
    const frame = await frameWith(setup, (f) => f.includes('· Main · online'))
    expect(frame).toContain('keith · Tony · Main · online')
    expect(core.credentials).toEqual({ username: 'pepper', password: 'potts-1234' })
    const stored = await loadSession(sessionFilePath(env))
    expect(stored?.url).toBe(core.url)
    expect(stored?.token).toStartWith('tok-')
    await waitUntil(() => core.openThreads().includes(core.thread.id), 3000, 'main thread open')
    setup.mockInput.pressKey('c', { ctrl: true })
    expect(await exit).toBe(0)
  })

  test('an invalid code exits 1 with the same sentence as the web app', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    cleanups.push(() => errors.mockRestore())
    const { core, setup, env, exit } = await start('not-the-code')
    await fillForm(setup, 'pepper', 'potts-1234')
    expect(await exit).toBe(1)
    expect(errors).toHaveBeenCalledWith(INVITE_INVALID_MESSAGE)
    expect(INVITE_INVALID_MESSAGE).toBe(
      'This invite link is not valid any more. Ask the owner for a new one.',
    )
    expect(await loadSession(sessionFilePath(env))).toBeNull()
    expect(core.credentials.username).toBe('tony')
  })

  test('a taken username shows the core message and asks again', async () => {
    const core = startFakeCore({ takenUsernames: ['tony'] })
    cleanups.push(() => core.stop())
    const home = await tempConfigHome()
    cleanups.push(home.cleanup)
    const setup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false })
    cleanups.push(() => setup.renderer.destroy())
    const exit = main(
      ['--url', core.url, '--invite', FAKE_INVITE_CODE],
      { XDG_CONFIG_HOME: home.dir },
      {
        createRenderer: async () => setup.renderer,
      },
    )
    await frameWith(setup, (f) => f.includes('sign up with your invite'))
    await fillForm(setup, 'tony', 'potts-1234')
    await frameWith(setup, (f) => f.includes("username 'tony' is taken"))
    setup.mockInput.pressKey('c', { ctrl: true })
    expect(await exit).toBe(0)
  })
})
