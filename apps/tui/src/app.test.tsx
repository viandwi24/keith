import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { render } from '@keith/ui/testing'
import { App } from './app.tsx'
import { type FakeCore, startFakeCore } from './testing/fake-core.ts'
import { chatReady, frameUntil, typeLine } from './testing/ink.ts'

let core: FakeCore | undefined
afterEach(() => core?.stop())

function app(rpc: Record<string, (input: unknown) => unknown> = {}, columns = 120) {
  core = startFakeCore({
    reply: 'Hello from Keith.',
    rpc: {
      'health/get': () => ({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot: 'b' }),
      'models/roles/get': () => ({ front: 'openrouter:anthropic/claude-haiku-5.5', cortex: null }),
      'auth/whoami': () => ({
        personId: 'owner',
        name: 'Owner',
        role: 'owner',
        via: 'tcp',
        credentialKind: 'device',
      }),
      ...rpc,
    },
  })
  const client = createKeithClient({ baseUrl: core.url, token: 't' })
  return render(<App start="chat" client={client} core={core.url} columns={columns} rows={40} />, {
    columns,
    rows: 40,
  })
}

describe('TUI', () => {
  test('under 60 columns it draws one muted line and nothing else', async () => {
    const { lastFrame, unmount } = app({}, 59)
    const frame = await frameUntil(lastFrame, (f) => f.includes('keith needs at least 60 columns'))
    expect(frame.trim()).toBe('keith needs at least 60 columns')
    unmount()
  })

  test('shows the connection, then streams a chat answer', async () => {
    const { lastFrame, stdin, unmount } = app()
    await frameUntil(lastFrame, (f) => f.includes('online'))
    await chatReady(lastFrame)
    await typeLine(stdin, 'hello')
    const frame = await frameUntil(lastFrame, (f) => f.includes('● Hello from Keith.'))
    expect(frame).toMatch(/› hello/)
    unmount()
  })

  test('/help lists the remaining commands; Esc goes back to chat', async () => {
    const { lastFrame, stdin, unmount } = app()
    await chatReady(lastFrame)
    await typeLine(stdin, '/help')
    const frame = await frameUntil(lastFrame, (f) => f.includes('/whoami'))
    for (const gone of ['/connect', '/providers', '/model ', '/pair']) {
      expect(frame).not.toContain(gone)
    }
    for (const group of ['Commands', 'Keys · Chat']) expect(frame).toContain(group)
    expect(frame).toContain('/tasks')
    expect(frame).toContain('[esc] back')
    // the page is longer than the screen: pgdn scrolls to the commands of the core machine
    for (
      let i = 0;
      i < 8 && !(lastFrame() ?? '').includes('keith-core model set front <id>');
      i++
    ) {
      stdin.write('\u001b[6~')
      await Bun.sleep(80)
    }
    const end = await frameUntil(lastFrame, (f) => f.includes('keith-core model set front <id>'))
    expect(end).toContain('On the core machine')
    expect(frame).not.toContain('type a message') // the input band is hidden on a screen
    stdin.write('\u001b')
    await frameUntil(lastFrame, (f) => f.includes('type a message') && !f.includes('Commands'))
    unmount()
  })

  test.each([
    ['/connect', 'keith-core provider add'],
    ['/providers', 'keith-core provider list'],
    ['/model', 'Models are set on the core machine:'],
    ['/model front x', 'keith-core model set front <id>'],
    ['/pair', 'keith-core pair'],
    ['/budget 25', 'keith-core budget set <usd|none>'],
  ])('%s shows the keith-core command instead of a settings screen', async (line, notice) => {
    const { lastFrame, stdin, unmount } = app()
    await chatReady(lastFrame)
    await typeLine(stdin, line)
    const frame = await frameUntil(lastFrame, (f) => f.includes(notice))
    expect(frame).toContain('type a message')
    expect(frame).toMatch(/· /) // an info notice: the prefix where the bar is not drawn
    expect(core?.seen.filter((l) => l.includes('providers/') || l.includes('budget/set'))).toEqual(
      [],
    )
    unmount()
  })

  test('/whoami shows the person, the core and how the client is connected', async () => {
    const { lastFrame, stdin, unmount } = app()
    await chatReady(lastFrame)
    await typeLine(stdin, '/whoami')
    const frame = await frameUntil(lastFrame, (f) => f.includes('via   device credential'))
    expect(frame).toContain('Owner  owner')
    expect(frame).toContain(core?.url ?? 'no url')
    expect(frame).toContain('core  0.0.0 (abc1234) · front openrouter:anthropic/claude-haiku-5.5')
    // a block in the conversation, not a screen: the input stays
    expect(frame).toContain('type a message')
    unmount()
  })

  test('the chat session is front:<personId> from whoami, not a hardcoded owner', async () => {
    const { lastFrame, stdin, unmount } = app({
      'auth/whoami': () => ({
        personId: 'ana',
        name: 'Ana',
        role: 'guest',
        via: 'tcp',
        credentialKind: 'device',
      }),
    })
    await chatReady(lastFrame)
    await typeLine(stdin, 'hello')
    await frameUntil(lastFrame, (f) => f.includes('Hello from Keith.'))
    expect(core?.seen).toContain('POST /sessions/front%3Aana/chat')
    expect(core?.seen.some((l) => l.includes('front%3Aowner'))).toBe(false)
    unmount()
  })

  test('a revoked credential shows the logged-out state and sends nothing', async () => {
    const { lastFrame, stdin, unmount } = app()
    await chatReady(lastFrame)
    core?.revoke()
    await frameUntil(lastFrame, (f) => f.includes('This device is logged out or its credential'))
    expect(lastFrame()).toContain('logged out')
    expect(lastFrame()).toContain('`enter` to sign in.')
    const before = core?.chats.length
    await typeLine(stdin, 'hello again')
    await Bun.sleep(100)
    expect(core?.chats.length).toBe(before)
    expect(lastFrame()).not.toContain('type a message')
    unmount()
  })
})
