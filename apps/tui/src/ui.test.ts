import { afterEach, describe, expect, test } from 'bun:test'
import { createChatClient, login } from '@keith/client'
import { type FakeCoreOptions, startFakeCore, waitUntil } from '@keith/client/testing'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import { promptLogin } from './login-screen.ts'
import { mountChat } from './ui.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function renderer(): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false })
  cleanups.push(() => setup.renderer.destroy())
  return setup
}

async function chat(opts: FakeCoreOptions = {}, paging: { historyLimit?: number; pageSize?: number } = {}) {
  const core = startFakeCore(opts)
  cleanups.push(() => core.stop())
  const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
  const setup = await renderer()
  let quits = 0
  let loadOlderCalls = 0
  const client = createChatClient({
    baseUrl: core.url,
    token,
    client: { name: 'keith-tui', version: '0.0.0' },
    onState: (state) => screen.update(state),
    historyLimit: paging.historyLimit,
    historyPageSize: paging.pageSize,
  })
  cleanups.push(() => client.close())
  const screen = mountChat(setup.renderer, {
    send: (text) => client.send(text),
    cancel: () => client.cancel(),
    loadOlder: () => {
      loadOlderCalls += 1
      void client.loadOlder()
    },
    quit: () => {
      quits += 1
    },
  })
  client.start()
  await waitUntil(() => client.state.thread !== null, 3000, 'thread.opened')
  return { core, client, screen, setup, quits: () => quits, loadOlderCalls: () => loadOlderCalls }
}

/** The terminal's PgUp sequence (the mock's named keys have no PgUp outside kitty mode). */
const PAGE_UP = '\x1b[5~'

/** The screen row showing `history <n>` (the fake core's seeded messages), or -1. */
function rowOf(frame: string, n: number): number {
  return frame.split('\n').findIndex((line) => new RegExp(`history ${n}(?!\\d)`).test(line))
}

describe('chat screen', () => {
  test('Enter sends the draft, clears the input and shows the streamed reply', async () => {
    const { core, screen, setup } = await chat()
    await setup.mockInput.typeText('hello keith')
    expect(screen.input.plainText).toBe('hello keith')
    setup.mockInput.pressEnter()
    await waitUntil(() => core.received.some((f) => f.type === 'input.text'), 3000, 'input.text')
    expect(core.received.find((f) => f.type === 'input.text')).toMatchObject({
      data: { text: 'hello keith' },
    })
    expect(screen.input.plainText).toBe('')
    const frame = await setup.waitForFrame((f) => f.includes('You said: hello keith') && !f.includes('▍'))
    expect(frame).toContain('You    hello keith')
    expect(frame).toContain('Keith  You said: hello keith')
    expect(frame).toContain('keith · Tony · main · online')
  })

  test('Ctrl+J inserts a newline instead of sending', async () => {
    const { core, screen, setup } = await chat()
    await setup.mockInput.typeText('line one')
    setup.mockInput.pressKey('j', { ctrl: true })
    await setup.mockInput.typeText('line two')
    expect(screen.input.plainText).toBe('line one\nline two')
    expect(core.received.some((f) => f.type === 'input.text')).toBe(false)
  })

  test('S-2, I-11: a proactive message renders while typing without losing the draft', async () => {
    const { core, screen, setup } = await chat()
    await setup.mockInput.typeText('half a thou')
    await core.pushProactive('Sir, the venue shortlist is ready.')
    const frame = await setup.waitForFrame((f) => f.includes('Keith ▸ Sir, the venue shortlist is ready.'))
    expect(frame).toContain('Keith ▸')
    expect(screen.input.plainText).toBe('half a thou')
    await setup.mockInput.typeText('ght')
    expect(screen.input.plainText).toBe('half a thought')
  })

  test('Esc sends input.cancel during a turn and Ctrl+C quits', async () => {
    const { core, client, setup, quits } = await chat({ tickMs: 50 })
    client.send('go')
    await waitUntil(() => client.state.turnState !== 'idle', 3000, 'turn')
    setup.mockInput.pressEscape()
    await waitUntil(() => core.received.some((f) => f.type === 'input.cancel'), 3000, 'input.cancel')
    setup.mockInput.pressKey('c', { ctrl: true })
    expect(quits()).toBe(1)
  })

  test('shows the reconnecting state when the core goes away', async () => {
    const { core, setup } = await chat()
    await core.stop()
    const frame = await setup.waitForFrame((f) => f.includes('offline, reconnecting'))
    expect(frame).toContain('attempt 1')
  })
})

describe('history scrollback', () => {
  test('PgUp to the top loads the older page above the view and keeps the view in place', async () => {
    const { client, screen, setup } = await chat({ history: 60 }, { historyLimit: 20, pageSize: 20 })
    await waitUntil(() => client.state.entries.length === 20, 3000, 'first page')
    const bottom = await setup.waitForFrame((f) => f.includes('history 60'))
    expect(rowOf(bottom, 41)).toBe(-1)
    // The log is taller than the view: PgUp scrolls to its top, which asks for the previous page.
    setup.mockInput.pressKey(PAGE_UP)
    await waitUntil(() => client.state.entries.length === 40, 3000, 'older page')
    const frame = await setup.waitForFrame((f) => rowOf(f, 40) !== -1)
    // Row 0 is the status bar. At the top, row 1 was the history line and row 2 `history 41`:
    // after the page is prepended, `history 41` stays on row 2 with `history 40` just above it.
    expect(rowOf(frame, 41)).toBe(2)
    expect(rowOf(frame, 40)).toBe(1)
    expect(rowOf(frame, 21)).toBe(-1)
    expect(screen.log.scrollTop).toBeGreaterThan(0)
    expect(screen.input.plainText).toBe('')
    expect(client.state.history.hasMore).toBe(true)
    const first = client.state.entries[0]
    expect(first?.kind === 'message' && first.text).toBe('history 21')
  })

  test('scrolling up loads pages until hasMore is false, then shows the start of the conversation', async () => {
    const { client, screen, setup, loadOlderCalls } = await chat(
      { history: 45 },
      { historyLimit: 20, pageSize: 20 },
    )
    await waitUntil(() => client.state.entries.length === 20, 3000, 'first page')
    await setup.waitForFrame((f) => f.includes('history 45'))
    for (const expected of [40, 45]) {
      await setup.mockMouse.scroll(10, 5, 'up', {})
      while (screen.log.scrollTop > 0) await setup.mockMouse.scroll(10, 5, 'up', {})
      await waitUntil(() => client.state.entries.length === expected, 3000, `${expected} entries`)
      await setup.renderOnce()
    }
    expect(client.state.history.hasMore).toBe(false)
    const calls = loadOlderCalls()
    screen.log.scrollTop = 0
    const frame = await setup.waitForFrame((f) => f.includes('start of the conversation'))
    expect(rowOf(frame, 1)).toBe(2)
    setup.mockInput.pressKey(PAGE_UP)
    expect(loadOlderCalls()).toBe(calls)
    expect(client.state.entries.length).toBe(45)
  })
})

describe('login screen', () => {
  test('asks for username then a masked password', async () => {
    const setup = await renderer()
    const result = promptLogin(setup.renderer, {
      url: 'http://127.0.0.1:4824',
      message: 'wrong username or password',
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('wrong username or password')
    await setup.mockInput.typeText('tony')
    setup.mockInput.pressEnter()
    await setup.mockInput.typeText('jarvis')
    const frame = await setup.waitForFrame((f) => f.includes('••••••'))
    expect(frame).not.toContain('jarvis')
    setup.mockInput.pressEnter()
    expect(await result).toEqual({ username: 'tony', password: 'jarvis' })
  })

  test('Ctrl+C cancels', async () => {
    const setup = await renderer()
    const result = promptLogin(setup.renderer, { url: 'http://127.0.0.1:4824' })
    setup.mockInput.pressKey('c', { ctrl: true })
    expect(await result).toBeNull()
  })
})
