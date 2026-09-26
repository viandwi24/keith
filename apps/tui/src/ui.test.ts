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

async function chat(opts: FakeCoreOptions = {}) {
  const core = startFakeCore(opts)
  cleanups.push(() => core.stop())
  const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
  const setup = await renderer()
  let quits = 0
  const client = createChatClient({
    baseUrl: core.url,
    token,
    client: { name: 'keith-tui', version: '0.0.0' },
    onState: (state) => screen.update(state),
  })
  cleanups.push(() => client.close())
  const screen = mountChat(setup.renderer, {
    send: (text) => client.send(text),
    cancel: () => client.cancel(),
    quit: () => {
      quits += 1
    },
  })
  client.start()
  await waitUntil(() => client.state.thread !== null, 3000, 'thread.opened')
  return { core, client, screen, setup, quits: () => quits }
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
