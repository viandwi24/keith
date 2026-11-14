import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stripAnsi } from './testing/ansi.ts'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const ESC = '\u001b'
const ENTER = '\r'
// built at runtime: fake secrets, never literals
const SECRET = `${'pw'}-${'q7'.repeat(5)}`
const PIN = ['4', '8', '1', '5', '9', '2'].join('')
const PASSWORD = { username: 'owner', password: SECRET }

type App = Awaited<ReturnType<typeof setupApp>>

/** Every frame the run drew, colour stripped. */
const history = (app: App): string => app.frames.map(stripAnsi).join('\n')

const press = (app: App, key: string, check: (f: string) => boolean) =>
  pressUntil(app.stdin, app.lastFrame, key, check)

/** Open the Sign in screen from the chat (`/login`), up to the box that asks who. */
async function toWho(app: App): Promise<void> {
  await typeLine(app.stdin, '/login')
  await frameUntil(app.lastFrame, (f) => f.includes('Which core do you want'))
  await press(app, ENTER, (f) => f.includes('id, username, email or phone'))
  await Bun.sleep(100)
}

describe('the Sign in screen, end to end', () => {
  test('/login: address, who, the PIN, then Home on the new client; the PIN is in no frame', async () => {
    const app = await setupApp({
      start: 'chat',
      flow: { context: 'loopback', people: { owner: { pin: PIN } } },
    })
    await toWho(app)
    await typeLine(app.stdin, 'owner')
    await frameUntil(app.lastFrame, (f) => f.includes('[PIN]') && f.includes('[enter] sign in'))
    await Bun.sleep(100)
    for (const ch of PIN) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    await frameUntil(app.lastFrame, (f) => f.includes('••••••'))
    app.stdin.write(ENTER)
    const f = await frameUntil(
      app.lastFrame,
      (x) => x.includes('signed in as Owner') && x.includes('[enter] chat'),
    )
    expect(f).toContain('K E I T H')
    expect(app.core.identified).toEqual(['owner'])
    expect(app.core.flowAnswers).toEqual([{ identifier: 'owner', method: 'pin' }])
    // not remembered: the sign in is in memory only
    expect(existsSync(app.configPath)).toBe(false)
    expect(history(app)).not.toContain(PIN)
    app.unmount()
  })

  test('a core without /auth/identify gets the older flow: the identifier is the username', async () => {
    const app = await setupApp({ start: 'chat', auth: { password: PASSWORD } })
    await toWho(app)
    await typeLine(app.stdin, 'owner')
    await frameUntil(
      app.lastFrame,
      (f) => f.includes('[Password]') && f.includes('[enter] sign in'),
    )
    await Bun.sleep(100)
    await typeLine(app.stdin, SECRET)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    expect(app.core.logins).toEqual([{ username: 'owner' }])
    expect(history(app)).not.toContain(SECRET)
    app.unmount()
  })

  test('the identifier that signed in is pre-filled the next time', async () => {
    const app = await setupApp({
      start: 'chat',
      flow: { people: { owner: { pin: PIN } } },
    })
    await toWho(app)
    await typeLine(app.stdin, 'owner')
    await frameUntil(app.lastFrame, (f) => f.includes('[PIN]') && f.includes('[enter] sign in'))
    await Bun.sleep(100)
    await typeLine(app.stdin, PIN)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    const state = JSON.parse(
      readFileSync(app.configPath.replace(/client\.json$/, 'client-state.json'), 'utf8'),
    ) as { identifiers: Record<string, string> }
    expect(Object.values(state.identifiers)).toEqual(['owner'])
    app.unmount()
  })
})

describe('the chat when logged out', () => {
  test('enter in the logged-out block opens the sign in', async () => {
    const app = await setupApp({ start: 'chat', loggedOut: true })
    await frameUntil(app.lastFrame, (f) => f.includes('`enter` to sign in.'))
    await press(app, ENTER, (f) => f.includes('Which core do you want'))
    // esc leaves it for the chat it came from
    await press(app, ESC, (f) => f.includes('`enter` to sign in.') && !f.includes('Which core'))
    app.unmount()
  })
})

describe('slash commands', () => {
  test('/login opens the sign in and esc comes back to the chat', async () => {
    const app = await setupApp({ start: 'chat' })
    await typeLine(app.stdin, '/login')
    await frameUntil(app.lastFrame, (f) => f.includes('Which core do you want'))
    await press(app, ESC, (f) => f.includes('type a message') && !f.includes('Which core'))
    app.unmount()
  })

  test('/whoami says who you are in the chat', async () => {
    const app = await setupApp({ start: 'chat' })
    await typeLine(app.stdin, '/whoami')
    await frameUntil(app.lastFrame, (f) => f.includes('Owner') && f.includes('credential'))
    app.unmount()
  })

  test('/logout asks first; n cancels and nothing is revoked', async () => {
    const app = await setupApp({ start: 'chat' })
    await typeLine(app.stdin, '/logout')
    await frameUntil(app.lastFrame, (f) => f.includes('Sign out of') && f.includes('[y] sign out'))
    await press(app, 'n', (f) => f.includes('type a message'))
    expect(app.core.logouts).toBe(0)
    app.unmount()
  })

  test('/logout of a sign in kept in memory revokes it and leaves a different saved login alone', async () => {
    const app = await setupApp({
      start: 'chat',
      flow: { people: { owner: { pin: PIN } } },
      savedLogin: { token: 'keith_s_legacy' },
    })
    await toWho(app)
    await typeLine(app.stdin, 'owner')
    await frameUntil(app.lastFrame, (f) => f.includes('[PIN]') && f.includes('[enter] sign in'))
    await Bun.sleep(100)
    await typeLine(app.stdin, PIN)
    await frameUntil(app.lastFrame, (x) => x.includes('signed in as Owner'))
    await Bun.sleep(300)
    app.stdin.write(ENTER)
    await frameUntil(app.lastFrame, (f) => f.includes('type a message'))
    await Bun.sleep(200)
    await typeLine(app.stdin, '/logout')
    await frameUntil(app.lastFrame, (f) => f.includes('[y] sign out'))
    await press(app, 'y', (f) => f.includes('▸ who'))
    expect(app.core.logouts).toBe(1)
    expect(JSON.parse(readFileSync(app.configPath, 'utf8'))).toMatchObject({
      token: 'keith_s_legacy',
    })
    app.unmount()
  }, 20_000)

  test('/logout, y: the credential is revoked and forgotten, and Home asks who', async () => {
    const app = await setupApp({ start: 'chat', auth: { password: PASSWORD } })
    writeFileSync(app.configPath, JSON.stringify({ core: app.core.url, token: 't' }))
    await typeLine(app.stdin, '/logout')
    await frameUntil(app.lastFrame, (f) => f.includes('[y] sign out'))
    await press(app, 'y', (f) => f.includes('▸ who'))
    expect(app.core.logouts).toBe(1)
    expect(existsSync(app.configPath)).toBe(false)
    app.unmount()
  })
})
