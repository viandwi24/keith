import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { memorySessionStore, type SessionStore, type StoredSession } from '@keith/client'
import { type FakeCore, startFakeCore, waitUntil } from '@keith/client/testing'
import type { UiBlock } from '@keith/protocol'
import { useDom } from '../test/dom.ts'

useDom()
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { App } = await import('./app.tsx')

// Frames arrive over real sockets at any time and `waitFor` polls for their effect, so React's
// "not wrapped in act(...)" warnings (meant for synchronous setups) are turned off for this file.
beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
})

let core: FakeCore | null = null
afterEach(async () => {
  cleanup()
  await core?.stop()
  core = null
})

function start(opts: Parameters<typeof startFakeCore>[0] = {}): FakeCore {
  core = startFakeCore(opts)
  return core
}

type View = ReturnType<typeof render>

function mount(fake: FakeCore, store: SessionStore = memorySessionStore()): View {
  return render(<App baseUrl={fake.url} store={store} />)
}

async function signIn(view: View, username = 'tony', password = 'jarvis') {
  const user = await waitFor(() => {
    const el = view.container.querySelector<HTMLInputElement>('input[name="username"]')
    if (!el) throw new Error('no login form')
    return el
  })
  const pass = view.container.querySelector<HTMLInputElement>('input[name="password"]')
  if (!pass) throw new Error('no password field')
  fireEvent.change(user, { target: { value: username } })
  fireEvent.change(pass, { target: { value: password } })
  const form = user.closest('form')
  if (!form) throw new Error('no form')
  await act(async () => {
    fireEvent.submit(form)
  })
}

async function online(view: View) {
  await waitFor(() => {
    const badge = view.container.querySelector('[data-slot="connection"]')
    if (badge?.getAttribute('data-status') !== 'online') throw new Error('not online yet')
    if (!view.container.querySelector('textarea')) throw new Error('no composer')
  })
}

async function send(view: View, text: string) {
  const box = view.container.querySelector('textarea')
  if (!box) throw new Error('no composer')
  fireEvent.change(box, { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })
}

function messages(view: View, role?: 'user' | 'assistant') {
  const selector = role ? `[data-slot="message"][data-role="${role}"]` : '[data-slot="message"]'
  return [...view.container.querySelectorAll(selector)]
}

describe('web app against the fake core', () => {
  test('signs in, keeps the session in the store, opens the thread with ui.render@1', async () => {
    const fake = start()
    const store = memorySessionStore()
    const view = mount(fake, store)
    await signIn(view)
    await online(view)
    expect((await store.load())?.token).toStartWith('tok-')
    // The node id from `welcome` is saved with the session, so the core recognizes this browser.
    await waitUntil(() => (store.load() as StoredSession | null)?.nodeId === fake.nodeId)
    const hello = fake.received.find((f) => f.type === 'hello')
    expect(hello?.type === 'hello' ? hello.data.capabilities : []).toEqual(['chat.text@1', 'ui.render@1'])
    expect(hello?.type === 'hello' ? hello.data.client.name : '').toBe('keith-web')
    expect(view.container.textContent).toContain('Tony')
  })

  test('a wrong password shows an error and stays on the login screen', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view, 'tony', 'wrong')
    await waitFor(() => expect(view.container.textContent).toContain('wrong username or password'))
    expect(view.container.querySelector('textarea')).toBeNull()
  })

  test('a stored session skips the login screen', async () => {
    const fake = start()
    const store = memorySessionStore()
    const first = mount(fake, store)
    await signIn(first)
    await online(first)
    cleanup()
    const second = mount(fake, store)
    await online(second)
    expect(second.container.querySelector('input[name="password"]')).toBeNull()
    expect(fake.hellos).toBe(2)
  })

  test('sends a message and shows the streamed reply, tool activity and turn state', async () => {
    const fake = start({ toolActivity: true, tickMs: 5 })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await send(view, 'hello there')
    expect(messages(view, 'user')[0]?.textContent).toContain('hello there')
    await waitFor(() => {
      const turn = view.container.querySelector('[data-slot="turn-state"]')
      if (turn?.getAttribute('data-state') === 'idle') throw new Error('turn not started')
    })
    await waitFor(() =>
      expect(messages(view, 'assistant')[0]?.textContent).toContain('You said: hello there'),
    )
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="turn-state"]')?.getAttribute('data-state')).toBe(
        'idle',
      ),
    )
    const tool = view.container.querySelector('[data-slot="tool-activity"]')
    expect(tool?.getAttribute('data-status')).toBe('completed')
    expect(tool?.textContent).toContain('web.search')
    expect(view.container.querySelector('[data-slot="streaming"]')).toBeNull()
  })

  test('cancel sends input.cancel while a turn runs', async () => {
    const fake = start({ tickMs: 40, reply: () => 'one two three four five six seven eight' })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await send(view, 'long answer please')
    const cancel = await waitFor(() => {
      const button = [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
      if (!button) throw new Error('no cancel button')
      return button
    })
    await act(async () => {
      fireEvent.click(cancel)
    })
    await waitUntil(() => fake.received.some((f) => f.type === 'input.cancel'))
  })

  test('proactive messages are marked', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await act(async () => {
      await fake.pushProactive('The venue research is done.')
    })
    await waitFor(() => {
      const msg = messages(view, 'assistant').find((m) => m.textContent?.includes('venue research'))
      if (!msg) throw new Error('no proactive message yet')
      expect(msg.getAttribute('data-proactive')).toBe('true')
      expect(msg.textContent).toContain('on its own')
    })
  })

  test('renders a reply block and sends ui.action for its button', async () => {
    const block: UiBlock = {
      type: 'card',
      id: 'weather',
      title: 'Surabaya',
      children: [{ type: 'actions', id: 'more', actions: [{ id: 'hourly', label: 'Hourly', value: 3 }] }],
    }
    const fake = start({ replyUi: () => block })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await send(view, 'weather?')
    const button = await waitFor(() => {
      const el = view.container.querySelector<HTMLButtonElement>('[data-action-id="hourly"]')
      if (!el) throw new Error('no block yet')
      return el
    })
    const messageId = button.closest('[data-slot="message"]')?.getAttribute('data-message-id')
    expect(messageId).toStartWith('msg_')
    await act(async () => {
      fireEvent.click(button)
    })
    await waitUntil(() => fake.received.some((f) => f.type === 'ui.action'))
    const action = fake.received.find((f) => f.type === 'ui.action')
    expect(action?.data as unknown).toEqual({
      threadId: fake.thread.id,
      messageId,
      blockId: 'more',
      actionId: 'hourly',
      value: 3,
    })
  })

  test('a floating block renders in the thread', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await act(async () => {
      fake.pushUi({ type: 'markdown', id: 'note', text: 'Floating **note**' })
    })
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="floating-ui"]')?.textContent).toContain(
        'Floating note',
      ),
    )
  })

  test('history loads, older pages load on demand, empty tool-step rows are hidden', async () => {
    const fake = start({ history: 60 })
    fake.messages.splice(1, 0, {
      id: 'msg_01J8ZQ3K4M000000000000ZZZZ',
      threadId: fake.thread.id,
      role: 'assistant',
      authorPersonId: null,
      modality: 'text',
      content: '',
      createdAt: 1,
    })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await waitFor(() => expect(messages(view)).toHaveLength(50))
    const older = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Load older messages',
    )
    if (!older) throw new Error('no load older button')
    await act(async () => {
      fireEvent.click(older)
    })
    await waitFor(() => expect(messages(view)).toHaveLength(60))
    expect(messages(view)[0]?.textContent).toContain('history 1')
    expect(view.container.querySelector('[data-message-id="msg_01J8ZQ3K4M000000000000ZZZZ"]')).toBeNull()
  })

  test('shows the reconnect state and comes back when the core does', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await act(async () => {
      await fake.stop()
    })
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="connection-banner"]')).not.toBeNull(),
    )
    expect(view.container.textContent).toContain('reconnecting')
    await fake.restart()
    const retry = [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Retry now')
    if (!retry) throw new Error('no retry button')
    await act(async () => {
      fireEvent.click(retry)
    })
    await online(view)
    expect(view.container.querySelector('[data-slot="connection-banner"]')).toBeNull()
  })

  test('a rejected token asks to sign in again, then reconnects with the new token', async () => {
    const fake = start()
    const store = memorySessionStore()
    const view = mount(fake, store)
    await signIn(view)
    await online(view)
    fake.revokeTokens()
    await act(async () => {
      fake.dropConnections()
    })
    await waitFor(() => expect(view.container.textContent).toContain('Sign in again'))
    const hellos = fake.hellos
    await signIn(view)
    await online(view)
    expect(fake.hellos).toBe(hellos + 1)
    expect((await store.load())?.nodeId).toBe(fake.nodeId)
  })

  test('sign out clears the stored session', async () => {
    const fake = start()
    const store = memorySessionStore()
    const view = mount(fake, store)
    await signIn(view)
    await online(view)
    const out = [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')
    if (!out) throw new Error('no sign out button')
    await act(async () => {
      fireEvent.click(out)
    })
    await waitFor(() => expect(view.container.querySelector('input[name="password"]')).not.toBeNull())
    expect(await store.load()).toBeNull()
  })
})
