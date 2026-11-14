import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { stripAnsi } from './testing/ansi.ts'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

const flatText = (x: string): string => x.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')

afterEach(stopCores)

const ESC = '\u001b'
const ENTER = '\r'
const SHIFT_TAB = '\u001b[Z'
const TAB = '\t'
// built at runtime: fake secrets, never literals
const PIN = ['4', '8', '1', '5', '9', '2'].join('')
const PASSWORD = `${'pw'}-${'q7'.repeat(5)}`
const WHO = 'id, username, email or phone'

type App = Awaited<ReturnType<typeof setupApp>>

const home = (options: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({ start: 'home', loggedOut: true, rows: 30, ...options })

/** Every frame the run drew, colour stripped. */
const history = (app: App): string => app.frames.map(stripAnsi).join('\n')

const press = (app: App, key: string, check: (f: string) => boolean) =>
  pressUntil(app.stdin, app.lastFrame, key, check)

/** Wait for the box, then type the identifier and enter. */
async function identify(app: App, who: string): Promise<void> {
  await frameUntil(app.lastFrame, (f) => f.includes(WHO) && f.includes('[enter] next'))
  await Bun.sleep(100)
  await typeLine(app.stdin, who)
}

describe('the login panel on a signed-out Home', () => {
  test('Home opens on one box; the caption and the menu keys step aside', async () => {
    const app = await home({ flow: { people: {} } })
    const f = await frameUntil(app.lastFrame, (x) => x.includes(WHO))
    expect(f).toContain('Sign in')
    expect(f).toContain('K E I T H')
    expect(f).not.toContain('Signed out')
    expect(f).not.toContain('[space] menu')
    // space is typed into the box, it does not open the menu
    await Bun.sleep(100)
    app.stdin.write(' ')
    await Bun.sleep(100)
    expect(app.lastFrame()).not.toContain('Overview')
    app.unmount()
  })

  test('identify, then the PIN the core marked default: signs in and lands on Home', async () => {
    const app = await home({ flow: { people: { owner: { pin: PIN } } } })
    await identify(app, 'owner')
    const f = await frameUntil(
      app.lastFrame,
      (x) => x.includes('[PIN]') && x.includes('[enter] sign in'),
    )
    expect(f).toContain('Password')
    expect(f).toContain('[tab] method')
    await Bun.sleep(100)
    for (const ch of PIN) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    const typed = await frameUntil(app.lastFrame, (x) => x.includes('••••••'))
    expect(typed).not.toContain(PIN)
    app.stdin.write(ENTER)
    const done = await frameUntil(
      app.lastFrame,
      (x) => x.includes('signed in as Owner') && x.includes('[enter] chat'),
    )
    expect(done).not.toContain(WHO)
    expect(app.core.flowAnswers).toEqual([{ identifier: 'owner', method: 'pin' }])
    // not remembered: the credential is in memory only, nothing is written to disk
    expect(existsSync(app.configPath)).toBe(false)
    expect(history(app)).not.toContain(PIN)
    app.unmount()
  })

  test('ticking remember this device writes the marked credential; nothing is written without it', async () => {
    const app = await home({ flow: { people: { owner: { pin: PIN } } } })
    await identify(app, 'owner')
    const f = await frameUntil(app.lastFrame, (x) => x.includes('[ ] remember for 30 days'))
    expect(f).toContain('[ctrl+r] remember')
    expect(existsSync(app.configPath)).toBe(false)
    await Bun.sleep(100)
    app.stdin.write('\u0012')
    await frameUntil(app.lastFrame, (x) => x.includes('[x] remember for 30 days'))
    await typeLine(app.stdin, PIN)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    expect(app.core.flowAnswers).toEqual([{ identifier: 'owner', method: 'pin', remember: true }])
    const saved = JSON.parse(readFileSync(app.configPath, 'utf8')) as {
      token: string
      remember?: boolean
    }
    expect(saved.token.startsWith('keith_s_')).toBe(true)
    expect(saved.remember).toBe(true)
    expect(history(app)).not.toContain(PIN)
    app.unmount()
  })

  test('a saved login that was not remembered shows a notice and one action to forget it', async () => {
    const app = await home({
      flow: { people: { owner: { pin: PIN } } },
      savedLogin: { token: 'keith_s_legacy' },
    })
    const f = await frameUntil(app.lastFrame, (x) => x.includes(WHO))
    const flat = f.replace(/\s+/g, ' ')
    expect(flat).toContain('An old saved login (from before sign-in existed) is not used.')
    expect(flat).toContain('press ctrl+f to forget it')
    // nothing deleted by the start itself
    expect(existsSync(app.configPath)).toBe(true)
    await Bun.sleep(100)
    app.stdin.write('\u0006')
    await frameUntil(app.lastFrame, (x) => x.includes('The old saved login is forgotten.'))
    expect(existsSync(app.configPath)).toBe(false)
    app.unmount()
  })

  test('signing in over a saved login keeps it in memory and leaves the saved one alone', async () => {
    const app = await home({
      flow: { people: { owner: { pin: PIN } } },
      savedLogin: { token: 'keith_s_legacy' },
    })
    await identify(app, 'owner')
    await frameUntil(app.lastFrame, (x) => x.includes('[PIN]') && x.includes('[enter] sign in'))
    await Bun.sleep(100)
    await typeLine(app.stdin, PIN)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    const saved = JSON.parse(readFileSync(app.configPath, 'utf8')) as { token: string }
    expect(saved.token).toBe('keith_s_legacy')
    app.unmount()
  })

  test('a remembered login shows no notice', async () => {
    const app = await home({
      flow: { people: { owner: { pin: PIN } } },
      savedLogin: { token: 'keith_s_kept', remember: true },
    })
    const f = await frameUntil(app.lastFrame, (x) => x.includes(WHO))
    expect(f).not.toContain('earlier version')
    app.unmount()
  })

  test('tab switches to the password, which signs in too', async () => {
    const app = await home({ flow: { people: { owner: { pin: PIN, password: PASSWORD } } } })
    await identify(app, 'owner')
    await frameUntil(app.lastFrame, (x) => x.includes('[PIN]') && x.includes('[enter] sign in'))
    await press(app, TAB, (x) => x.includes('[Password]'))
    await Bun.sleep(100)
    await typeLine(app.stdin, PASSWORD)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    expect(app.core.flowAnswers).toEqual([{ identifier: 'owner', method: 'password' }])
    expect(history(app)).not.toContain(PASSWORD)
    app.unmount()
  })

  test('where the core refuses the PIN the password is on screen first, the PIN greyed with the reason', async () => {
    const app = await home({
      flow: { context: 'public', pin: false, people: { owner: { password: PASSWORD } } },
    })
    await identify(app, 'owner')
    const f = await frameUntil(app.lastFrame, (x) => x.includes('[Password]'))
    expect(f).toContain('! PIN')
    // shift+tab shows the PIN: refused here, so the core's reason and no field
    const g = await press(app, SHIFT_TAB, (x) => x.includes('[! PIN]'))
    expect(flatText(g)).toContain('not available here: not accepted from this network')
    expect(g).not.toContain('[enter] sign in')
    app.unmount()
  })

  test('the plain-HTTP warning shows on the lan and nowhere else', async () => {
    const lan = await home({ flow: { context: 'lan', people: { owner: { pin: PIN } } } })
    await identify(lan, 'owner')
    // the warning is drawn a moment after the PIN field on a busy machine: wait for both
    const f = await frameUntil(
      lan.lastFrame,
      (x) => x.includes('[PIN]') && flatText(x).includes('plain HTTP on this network'),
    )
    expect(flatText(f)).toContain('plain HTTP on this network')
    lan.unmount()
    stopCores()
    for (const context of ['loopback', 'tailscale', 'public'] as const) {
      const app = await home({ flow: { context, people: { owner: { pin: PIN, password: 'x' } } } })
      await identify(app, 'owner')
      const g = await frameUntil(app.lastFrame, (x) => x.includes('Token'))
      await Bun.sleep(100)
      expect(g).not.toContain('plain HTTP')
      expect(history(app)).not.toContain('plain HTTP')
      app.unmount()
      stopCores()
    }
  })

  test('an unknown identifier looks the same, and so does a wrong PIN', async () => {
    const lines: string[] = []
    for (const who of ['owner', 'alice']) {
      const app = await home({ flow: { people: { owner: { pin: '999999' } } } })
      await identify(app, who)
      const shown = await frameUntil(
        app.lastFrame,
        (x) => x.includes('[PIN]') && x.includes('[enter] sign in'),
      )
      await Bun.sleep(100)
      await typeLine(app.stdin, PIN)
      const failed = await frameUntil(app.lastFrame, (x) => x.includes('sign-in failed'))
      const strip = (x: string): string => x.replaceAll(who, '<who>').replace(/\s+$/gm, '')
      lines.push(strip(failed))
      expect(strip(shown)).toContain('Device code')
      app.unmount()
      stopCores()
    }
    expect(lines[0]).toBe(lines[1] as string)
    expect(flatText(lines[0] ?? '')).toContain('✕ sign-in failed: check your id and what')
  })

  test('a throttled answer shows the countdown and keeps the panel', async () => {
    const app = await home({ flow: { throttle: 30, people: { owner: { pin: PIN } } } })
    await identify(app, 'owner')
    await frameUntil(app.lastFrame, (x) => x.includes('[PIN]') && x.includes('[enter] sign in'))
    await Bun.sleep(100)
    await typeLine(app.stdin, PIN)
    const f = await frameUntil(app.lastFrame, (x) => x.includes('try again in'))
    expect(f).toMatch(/try again in \d+ s/)
    expect(f).not.toContain('[enter] chat')
    expect(history(app)).not.toContain(PIN)
    app.unmount()
  })

  test('esc goes back one step: the method returns to the box with the identifier; the box ignores esc', async () => {
    const app = await home({ flow: { people: { owner: { pin: PIN } } } })
    await identify(app, 'owner')
    await frameUntil(app.lastFrame, (x) => x.includes('[PIN]') && x.includes('[esc] back'))
    await press(
      app,
      ESC,
      (x) =>
        x.includes(WHO) === false &&
        x.includes('who') &&
        x.includes('owner') &&
        !x.includes('[PIN]'),
    )
    await Bun.sleep(200)
    app.stdin.write(ESC)
    await Bun.sleep(200)
    const f = app.lastFrame() ?? ''
    expect(f).toContain('Sign in')
    expect(f).toContain('who')
    expect(f).not.toContain('Which core')
    app.unmount()
  })

  test('a core that is an older one (no /auth/identify) gets the password panel', async () => {
    const app = await home({ auth: { password: { username: 'owner', password: PASSWORD } } })
    await identify(app, 'owner')
    await frameUntil(
      app.lastFrame,
      (x) => x.includes('[Password]') && x.includes('[enter] sign in'),
    )
    await Bun.sleep(100)
    await typeLine(app.stdin, PASSWORD)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    expect(app.core.logins).toEqual([{ username: 'owner' }])
    app.unmount()
  })

  test('the device code is a tab: enter asks for a code and the owner approves it', async () => {
    const app = await home({ flow: { people: {} } })
    await identify(app, 'owner')
    await frameUntil(app.lastFrame, (x) => x.includes('[PIN]') && x.includes('[enter] sign in'))
    await press(
      app,
      SHIFT_TAB,
      (x) => x.includes('[Device code]') && x.includes('[enter] ask for a code'),
    )
    await press(app, ENTER, (x) => x.includes('K T P W - 4 C 7 M'))
    app.core.decideDevice('approved')
    await frameUntil(
      app.lastFrame,
      (x) => x.includes('signed in as Owner') && x.includes('[enter] chat'),
    )
    app.unmount()
  })
})

describe('the login panel fits its content and stays on the legend axis', () => {
  const lines = (f: string): string[] => f.split('\n')
  const indent = (line: string): number => line.length - line.trimStart().length

  for (const columns of [60, 100, 160]) {
    test(`at ${columns} columns the frame is at most 56 wide, within the margins, and the notice is centred`, async () => {
      const app = await home({
        columns,
        rows: 30,
        flow: { people: { owner: { pin: PIN } } },
        savedLogin: { token: 'keith_s_legacy' },
      })
      const f = await frameUntil(
        app.lastFrame,
        (x) => x.includes(WHO) && x.includes('[enter] next'),
      )
      const top = lines(f).find((l) => l.includes('╭─ Sign in'))
      expect(top).toBeDefined()
      const frame = (top ?? '').trim()
      expect(frame.length).toBeLessThanOrEqual(56)
      expect(frame.length).toBeLessThanOrEqual(columns - 4)
      // the frame and the legend share the centre axis (within one cell of rounding)
      const legend = lines(f).find((l) => l.includes('[enter] next')) ?? ''
      const axis = (l: string): number => indent(l) + l.trim().length / 2
      expect(Math.abs(axis(top ?? '') - axis(legend))).toBeLessThanOrEqual(1.5)
      // the notice is centred on that axis too and no line overflows the terminal
      const notice = lines(f).find((l) => l.includes('saved login')) ?? ''
      expect(Math.abs(axis(notice) - axis(legend))).toBeLessThanOrEqual(4)
      for (const l of lines(f)) expect(l.length).toBeLessThanOrEqual(columns)
      app.unmount()
    })
  }
})
