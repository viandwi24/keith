import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { render } from '@keith/ui/testing'
import { App } from '../../app.tsx'
import { startFakeCore } from '../../testing/fake-core.ts'
import { MEMBER } from '../../testing/fake-core-types.ts'
import { approval } from '../../testing/fixtures.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const home = (options: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({ start: 'home', columns: 100, rows: 30, ...options })

describe('Home', () => {
  test('draws the title, the orb word, the legend and the header facts', async () => {
    const { lastFrame, unmount } = await home({
      columns: 120,
      rpc: { 'models/roles/get': () => ({ front: 'openrouter/x/haiku', cortex: null }) },
    })
    const f = await frameUntil(lastFrame, (x) => x.includes('online'))
    expect(f).toContain('K E I T H')
    expect(f).toContain('● idle')
    expect(f).toContain('[enter] chat')
    expect(f).toContain('[space] menu')
    expect(f).toContain('K E I T H')
    expect(f).toMatch(/✳ online/)
    expect(f).not.toContain('core 0.0.0')
    expect(f).not.toContain('front haiku')
    expect(f).toContain('╭─ idle')
    expect(f).not.toContain('type a message')
    unmount()
  })

  test('the brain frame hides below 80 columns; below 60 the too-narrow line shows', async () => {
    const narrow = await home({ columns: 70 })
    expect(narrow.lastFrame()).not.toContain('╭─ idle')
    expect(narrow.lastFrame()).toContain('K E I T H')
    narrow.unmount()
    stopCores()
    const core = startFakeCore({})
    const tiny = render(
      <App
        client={createKeithClient({ baseUrl: core.url, token: 't' })}
        core={core.url}
        columns={59}
        rows={30}
      />,
      { columns: 59, rows: 30 },
    )
    const f = await frameUntil(tiny.lastFrame, (x) => x.includes('keith needs at least 60'))
    expect(f.trim()).toBe('keith needs at least 60 columns')
    tiny.unmount()
    core.stop()
  })

  test('space opens the menu, a group opens a submenu, enter opens the detail, esc backs out then closes', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    let f = lastFrame() ?? ''
    for (const title of ['People & access', 'Apps', 'Models & budget', 'System', 'Help', 'Logout'])
      expect(f).toContain(title)
    // the leaves live inside the groups; there is no top-level Plugins
    expect(f).not.toContain('Brain trace')
    expect(f).not.toMatch(/\bPlugins\b/)
    expect(f).toContain('[↑↓] select')
    expect(f).toContain('[←] back')
    expect(f).not.toContain('[enter] chat')
    await pressUntil(stdin, lastFrame, '\u001b[B', (x) => x.includes('▸ People & access'))
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('▸ People') && !x.includes('Apps'))
    expect(lastFrame()).toContain('Groups')
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('╭─ People'))
    f = lastFrame() ?? ''
    expect(f).toContain('Who can sign in')
    // moving the selection updates the open box
    await pressUntil(stdin, lastFrame, 'j', (x) => x.includes('╭─ Groups'))
    await pressUntil(stdin, lastFrame, '\r', (x) => !x.includes('╭─ Groups'))
    // esc goes back to the groups, the selection on People & access; a second esc closes
    await pressUntil(stdin, lastFrame, '\u001b', (x) => x.includes('▸ People & access'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u001b',
      (x) => !x.includes('▸ ') && x.includes('[enter] chat'),
    )
    unmount()
  })

  test('Apps opens with Plugins and Reviews; left goes back; space closes from the submenu', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    await pressUntil(stdin, lastFrame, 'j', (f) => f.includes('▸ People & access'))
    await pressUntil(stdin, lastFrame, 'j', (f) => f.includes('▸ Apps'))
    await pressUntil(stdin, lastFrame, '\u001b[C', (f) => f.includes('▸ Plugins'))
    expect(lastFrame()).toContain('Reviews')
    expect(lastFrame()).not.toContain('Brain trace')
    await pressUntil(stdin, lastFrame, '\u001b[D', (f) => f.includes('▸ Apps'))
    await pressUntil(stdin, lastFrame, '\u001b[C', (f) => f.includes('▸ Plugins'))
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('[enter] chat'))
    // reopening starts at the top again
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    unmount()
  })

  test('the detail shows live data: the overview names the core and the front model', async () => {
    const { lastFrame, stdin, unmount } = await home({
      rpc: { 'models/roles/get': () => ({ front: 'openrouter/x/haiku', cortex: null }) },
    })
    await frameUntil(lastFrame, (f) => f.includes('online'))
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('╭─ Overview'))
    const f = await frameUntil(lastFrame, (x) => x.includes('front haiku'))
    expect(f).toContain('connection online')
    expect(f).toContain('core 0.0.0 ok')
    expect(f).toContain('you Owner (owner)')
    unmount()
  })

  test('over 80 % of the limit the Budget item has a ! and its box says so', async () => {
    const { lastFrame, stdin, unmount } = await home({ budget: { spentUsd: 18, limitUsd: 20 } })
    await frameUntil(lastFrame, (f) => f.includes('[space] menu'))
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    const f = await frameUntil(lastFrame, (x) => /Models & budget !/.test(x))
    expect(f).not.toMatch(/Overview !/)
    for (let i = 0; i < 12 && !/▸ Models & budget/.test(lastFrame() ?? ''); i++) {
      stdin.write('\u001b[B')
      await Bun.sleep(60)
    }
    await pressUntil(stdin, lastFrame, '\r', (x) => !x.includes('Overview'))
    for (let i = 0; i < 4 && !/▸ Budget/.test(lastFrame() ?? ''); i++) {
      stdin.write('j')
      await Bun.sleep(60)
    }
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('╭─ Budget'))
    const box = await frameUntil(lastFrame, (x) => x.includes('! over 80% of the limit'))
    expect(box).toContain('$18.00 / $20 this month')
    expect(box).toContain('$2.00 left')
    unmount()
  })

  test('right opens the section on the full Manage screen; esc comes back to Home', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    await pressUntil(stdin, lastFrame, '\u001b[B', (x) => x.includes('▸ People & access'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u001b[C',
      (x) => x.includes('▸ People') && !x.includes('Apps'),
    )
    await pressUntil(stdin, lastFrame, '\u001b[C', (f) => f.includes('Manage'))
    expect(lastFrame()).not.toContain('[space] menu')
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('[space] menu'))
    unmount()
  })

  test('enter on Help opens the full Help screen; esc comes back to Home', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    // wraps to Logout (the last entry), then Help
    await pressUntil(stdin, lastFrame, 'k', (f) => f.includes('▸ Logout'))
    await pressUntil(stdin, lastFrame, 'k', (f) => f.includes('▸ Help'))
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('Commands'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('[space] menu'))
    unmount()
  })

  test('the menu ends with Logout; enter opens the Sign out screen like /logout', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('▸ Overview'))
    await pressUntil(stdin, lastFrame, 'k', (f) => f.includes('▸ Logout'))
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('Logout')).toBeGreaterThan(frame.indexOf('Help'))
    // no blank row between Help and Logout
    const lines = frame.split('\n')
    const help = lines.findIndex((l) => l.includes('Help'))
    expect(lines[help + 1]).toContain('Logout')
    // the same Sign out screen `/logout` opens
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('Sign out of'))
    unmount()
  })

  test('enter opens the chat; esc returns Home; a draft makes the orb listen', async () => {
    const { lastFrame, stdin, unmount } = await home()
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('type a message'))
    await Bun.sleep(150)
    stdin.write('h')
    await frameUntil(lastFrame, (f) => /^\s+h\s*(│.*)?$/m.test(f))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('[space] menu'))
    expect(lastFrame()).toContain('● listening')
    expect(lastFrame()).not.toContain('type a message')
    unmount()
  })

  test('a running turn makes the orb think, then speak; the words show as the subtitle', async () => {
    const { lastFrame, stdin, unmount } = await home({ reply: 'Hello from **Keith**.' })
    await pressUntil(stdin, lastFrame, '\r', (f) => f.includes('type a message'))
    await Bun.sleep(150)
    for (const ch of 'hi') stdin.write(ch)
    await Bun.sleep(30)
    stdin.write('\r')
    // Esc while the turn still streams stops it (the footer says `[esc] stop`); wait until the turn
    // is over (`[esc] home`) so the Esc under test is the one that goes Home
    await frameUntil(lastFrame, (f) => f.includes('Hello from Keith.') && f.includes('[esc] home'))
    await pressUntil(stdin, lastFrame, '\u001b', (f) => f.includes('[space] menu'))
    await frameUntil(lastFrame, (f) => f.includes('Hello from Keith.') && f.includes('● idle'))
    unmount()
  })

  test('a member sees no admin sections in the menu', async () => {
    const { lastFrame, stdin, unmount } = await home({ whoami: MEMBER })
    await frameUntil(lastFrame, (f) => f.includes('[space] menu'))
    await pressUntil(stdin, lastFrame, ' ', (f) => f.includes('Help'))
    const f = lastFrame() ?? ''
    for (const admin of ['People', 'Groups', 'Devices', 'Access', 'Audit', 'Plugins', 'Reviews'])
      expect(f).not.toContain(admin)
    expect(f).toContain('System')
    for (let i = 0; i < 6 && !/▸ System/.test(lastFrame() ?? ''); i++) {
      stdin.write('j')
      await Bun.sleep(60)
    }
    await pressUntil(stdin, lastFrame, '\r', (x) => x.includes('Brain trace'))
    expect(lastFrame()).toContain('Tasks')
    expect(lastFrame()).not.toContain('Audit')
    unmount()
  })

  test('a pending approval shows its dialog on Home; tab gives it the keys', async () => {
    const { lastFrame, stdin, core, unmount } = await home({
      attention: [approval({ id: 'ap1' })],
    })
    const f = await frameUntil(lastFrame, (x) => x.includes('Approval needed'))
    expect(f).toContain('K E I T H')
    expect(f).toContain('tab to answer')
    await pressUntil(stdin, lastFrame, '\t', (x) => x.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, 'y', () => core.answers.length >= 1)
    await frameUntil(lastFrame, (x) => !x.includes('Approval needed'))
    unmount()
  })
})

describe('Home when signed out or the core is down', () => {
  const open = (down: boolean, columns = 100) => {
    const core = startFakeCore({})
    if (!down) core.revoke()
    const client = createKeithClient({
      baseUrl: down ? 'http://127.0.0.1:1' : core.url,
      token: 't',
    })
    const view = render(
      <App client={client} core="https://mac.example.ts.net" columns={columns} rows={30} />,
      { columns, rows: 30 },
    )
    return { ...view, stop: () => core.stop() }
  }

  test('logged out: alert orb, the Signed out caption, no chat key', async () => {
    const view = open(false)
    const f = await frameUntil(view.lastFrame, (x) => x.includes('Signed out'))
    expect(f).toContain('● alert')
    expect(f).toContain('sign in to https://mac.example.ts.net')
    expect(f).toContain('[enter] log in')
    expect(f).not.toContain('[enter] chat')
    expect(f).toContain('logged out')
    view.unmount()
    view.stop()
  })

  test('logged out: enter without a root that owns the connection stays on Home', async () => {
    const view = open(false)
    await frameUntil(view.lastFrame, (x) => x.includes('Signed out'))
    await Bun.sleep(100)
    view.stdin.write('\r')
    // the alert caption keeps the slot over the notice; nothing opens and nothing quits
    await Bun.sleep(150)
    expect(view.lastFrame()).toContain('Signed out')
    expect(view.lastFrame()).toContain('[enter] log in')
    view.unmount()
    view.stop()
  })

  test('core down: alert orb and a one-row caption with the core address', async () => {
    const view = open(true)
    const f = await frameUntil(view.lastFrame, (x) => x.includes('Cannot reach the core'))
    expect(f).toContain('● alert')
    expect(f).toContain('Cannot reach the core at')
    expect(f).not.toContain('keith-core start')
    expect(f).not.toContain('[enter] chat')
    view.unmount()
    view.stop()
  })
})
