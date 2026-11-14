import { afterEach, describe, expect, test } from 'bun:test'
import { GUEST_BANNER } from '@keith/contracts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const CTRL_G = '\u0007'
const ESC = '\u001b'
const WHO = 'id, username, email or phone'
const ROW = 'continue as an anonymous guest'

const home = (options: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({ start: 'home', loggedOut: true, rows: 34, guestVia: true, ...options })

describe('"continue as guest" on the signed-out Home', () => {
  test('shown when the core says guest chat is available; ctrl+g opens it and esc comes back', async () => {
    const app = await home({ flow: { people: {} }, guest: {} })
    await frameUntil(app.lastFrame, (f) => f.includes(WHO) && f.includes(ROW))
    expect(app.core.seen).toContain('GET /guest/status')
    await Bun.sleep(100)
    await pressUntil(
      app.stdin,
      app.lastFrame,
      CTRL_G,
      (f) => f.includes('K E I T H') && f.includes('Guest'),
    )
    const f = await frameUntil(app.lastFrame, (x) => x.includes('20 of 20 messages left'))
    expect(f).toContain(GUEST_BANNER.slice(0, 40))
    expect(f).not.toContain(WHO)
    expect(app.core.guest.opened).toBe(1)
    // esc ends the chat at the core and gives the sign-in panel back
    await Bun.sleep(100)
    await pressUntil(app.stdin, app.lastFrame, ESC, (x) => x.includes(WHO))
    expect(app.core.guest.deleted).toBe(1)
    app.unmount()
  })

  test('not shown when the core says it is not available, or has no guest listener at all', async () => {
    for (const options of [
      { guest: { status: { enabled: true, available: false } } },
      { guest: { status: { enabled: false, available: false } } },
      {},
    ]) {
      const app = await home({ flow: { people: {} }, ...options })
      await frameUntil(app.lastFrame, (f) => f.includes(WHO))
      await Bun.sleep(400)
      expect(app.lastFrame()).not.toContain(ROW)
      expect(app.lastFrame()).not.toContain('guest')
      // the key does nothing
      app.stdin.write(CTRL_G)
      await Bun.sleep(150)
      expect(app.lastFrame()).toContain(WHO)
      expect(app.core.guest.opened).toBe(0)
      app.unmount()
      stopCores()
    }
  })

  test('a signed-in Home has no guest entry at all', async () => {
    const app = await setupApp({ start: 'home', guestVia: true, guest: {} })
    await Bun.sleep(300)
    expect(app.lastFrame()).not.toContain(ROW)
    expect(app.core.seen).not.toContain('GET /guest/status')
    app.unmount()
  })
})
