import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveConnection } from './connection.ts'
import { stripAnsi } from './testing/ansi.ts'
import { frameUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

// built at runtime: fake secrets, never literals
const PIN = ['4', '8', '1', '5', '9', '2'].join('')
const WHO = 'id, username, email or phone'

/** The local socket whose owner needs a session (`local trust: none`): Home signs in through the socket. */
describe('the login panel on the local socket', () => {
  test('identify, the PIN, and the session stays in memory: no file, a new start asks again', async () => {
    const app = await setupApp({
      start: 'home',
      loggedOut: true,
      socket: true,
      rows: 30,
      flow: { people: { owner: { pin: PIN } } },
    })
    await frameUntil(app.lastFrame, (f) => f.includes(WHO) && f.includes('[enter] next'))
    await Bun.sleep(100)
    for (const ch of 'owner') {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('[PIN]') && f.includes('[enter] sign in'))
    await Bun.sleep(100)
    for (const ch of PIN) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    const typed = await frameUntil(app.lastFrame, (f) => f.includes('••••••'))
    expect(typed).not.toContain(PIN)
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('signed in') && f.includes('[enter] chat'))
    expect(app.core.flowAnswers).toEqual([{ identifier: 'owner', method: 'pin' }])
    // nothing on disk: neither a session file nor client.json (a login to a remote core is never replaced)
    expect(existsSync(join(dirname(app.configPath), 'socket-session.json'))).toBe(false)
    expect(existsSync(app.configPath)).toBe(false)
    // another start in the same OS account is signed out: a visitor never inherits this session
    const next = await resolveConnection({
      configPath: app.configPath,
      dataDir: dirname(app.configPath),
      core: `unix:${join(dirname(app.configPath), 'core.sock')}`,
    })
    expect(next).toMatchObject({ kind: 'socket' })
    expect(next).not.toHaveProperty('token')
    expect(app.frames.map(stripAnsi).join('\n')).not.toContain(PIN)
    app.unmount()
  })

  test('a fresh install: the owner has no sign-in, so the panel sets the first PIN (typed twice), once', async () => {
    const app = await setupApp({
      start: 'home',
      loggedOut: true,
      socket: true,
      rows: 30,
      flow: { people: {}, firstOwner: true },
    })
    await frameUntil(
      app.lastFrame,
      (f) => f.includes('First sign-in') && f.includes('Choose a PIN'),
    )
    await Bun.sleep(100)
    const type = async (text: string) => {
      for (const ch of text) {
        app.stdin.write(ch)
        await Bun.sleep(2)
      }
      app.stdin.write('\r')
    }
    await type(PIN)
    await frameUntil(app.lastFrame, (f) => f.includes('Again'))
    await type(PIN)
    await frameUntil(app.lastFrame, (f) => f.includes('signed in') && f.includes('[enter] chat'))
    expect(app.core.firstOwnerSets).toHaveLength(1)
    expect(app.frames.map(stripAnsi).join('\n')).not.toContain(PIN)
    app.unmount()
  })

  test('a PIN that differs the second time starts again and sets nothing', async () => {
    const app = await setupApp({
      start: 'home',
      loggedOut: true,
      socket: true,
      rows: 30,
      flow: { people: {}, firstOwner: true },
    })
    await frameUntil(app.lastFrame, (f) => f.includes('First sign-in'))
    await Bun.sleep(100)
    for (const ch of PIN) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Again'))
    await Bun.sleep(100)
    for (const ch of `${PIN}0`) {
      app.stdin.write(ch)
      await Bun.sleep(2)
    }
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('the PINs differ'))
    expect(app.core.firstOwnerSets).toHaveLength(0)
    app.unmount()
  })

  test('once an owner sign-in exists the first-owner panel is not offered (the normal sign in is)', async () => {
    const app = await setupApp({
      start: 'home',
      loggedOut: true,
      socket: true,
      rows: 30,
      flow: { people: { owner: { pin: PIN } }, firstOwner: false },
    })
    await frameUntil(app.lastFrame, (f) => f.includes(WHO))
    expect(app.lastFrame()).not.toContain('First sign-in')
    app.unmount()
  })
})
