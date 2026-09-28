import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { memorySessionStore, type SessionStore } from '@keith/client'
import { FAKE_INVITE_CODE, type FakeCore, fakeId, startFakeCore, waitUntil } from '@keith/client/testing'
import type { PersonDto } from '@keith/protocol'
import type { AddressBar } from '../lib/invite.ts'
import { useDom } from '../test/dom.ts'

useDom()
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { App } = await import('./app.tsx')

// Frames arrive over real sockets at any time and `waitFor` polls for their effect (see app.test.tsx).
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

const pepper: PersonDto = { id: fakeId('per', 2), name: 'Pepper', tier: 'member' }
const rhodey: PersonDto = { id: fakeId('per', 3), name: 'Rhodey', tier: 'member' }

const INVALID = 'This invite link is not valid any more. Ask the owner for a new one.'

type View = ReturnType<typeof render>

/** An address bar holding `hash` that records when the app clears it. */
function fakeAddress(hash: string): AddressBar & { cleared: number } {
  let current = hash
  const bar = {
    cleared: 0,
    hash: () => current,
    clearHash() {
      current = ''
      bar.cleared += 1
    },
  }
  return bar
}

function mount(fake: FakeCore, opts: { store?: SessionStore; address?: AddressBar } = {}): View {
  return render(
    <App
      baseUrl={fake.url}
      store={opts.store ?? memorySessionStore()}
      address={opts.address ?? fakeAddress('')}
    />,
  )
}

function field(view: View, name: string): HTMLInputElement {
  const el = view.container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
  if (!el) throw new Error(`no ${name} field`)
  return el
}

async function submit(view: View, values: Record<string, string>) {
  const first = await waitFor(() => field(view, 'username'))
  for (const [name, value] of Object.entries(values))
    fireEvent.change(field(view, name), { target: { value } })
  const form = first.closest('form')
  if (!form) throw new Error('no form')
  await act(async () => {
    fireEvent.submit(form)
  })
}

async function signIn(view: View) {
  await submit(view, { username: 'tony', password: 'jarvis' })
}

async function online(view: View) {
  await waitFor(() => {
    const badge = view.container.querySelector('[data-slot="connection"]')
    if (badge?.getAttribute('data-status') !== 'online') throw new Error('not online yet')
    const box = view.container.querySelector('textarea')
    if (box?.getAttribute('placeholder') !== 'Message Keith') throw new Error('no thread yet')
  })
}

function threadItems(view: View) {
  const list = view.container.querySelector('[data-slot="sidebar"] [data-slot="thread-list"]')
  return [...(list?.querySelectorAll<HTMLButtonElement>('[data-slot="thread-item"]') ?? [])]
}

function label(view: View): string {
  return view.container.querySelector('[data-slot="thread-label"]')?.textContent ?? ''
}

function messages(view: View, role?: 'user' | 'assistant') {
  const selector = role ? `[data-slot="message"][data-role="${role}"]` : '[data-slot="message"]'
  return [...view.container.querySelectorAll(selector)]
}

describe('invite link sign-up', () => {
  test('the invite fragment shows the form; signing up lands in the chat and clears the fragment', async () => {
    const fake = start()
    const store = memorySessionStore()
    const address = fakeAddress(`#invite=${FAKE_INVITE_CODE}`)
    const view = mount(fake, { store, address })
    await waitFor(() => expect(view.container.querySelector('[data-slot="invite"]')).not.toBeNull())
    expect(view.container.querySelector('input[name="repeat"]')).not.toBeNull()
    await submit(view, { username: 'pepper', password: 'rescue-armor', repeat: 'rescue-armor' })
    await online(view)
    expect(address.cleared).toBe(1)
    expect(address.hash()).toBe('')
    expect(fake.credentials).toEqual({ username: 'pepper', password: 'rescue-armor' })
    expect((await store.load())?.token).toStartWith('tok-')
  })

  test('different passwords are refused before anything is sent', async () => {
    const fake = start()
    const address = fakeAddress(`#invite=${FAKE_INVITE_CODE}`)
    const view = mount(fake, { address })
    await submit(view, { username: 'pepper', password: 'rescue-armor', repeat: 'rescue-armour' })
    await waitFor(() => expect(view.container.textContent).toContain('The passwords do not match.'))
    expect(fake.credentials.username).toBe('tony')
    expect(address.cleared).toBe(0)
  })

  test('an invalid code shows the message, then the sign-in form on request', async () => {
    const fake = start()
    const address = fakeAddress('#invite=not-a-real-code')
    const view = mount(fake, { address })
    await submit(view, { username: 'pepper', password: 'rescue-armor', repeat: 'rescue-armor' })
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="invite-invalid"]')?.textContent).toBe(INVALID),
    )
    expect(view.container.querySelector('input[name="repeat"]')).toBeNull()
    const back = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign in instead',
    )
    if (!back) throw new Error('no sign in button')
    await act(async () => {
      fireEvent.click(back)
    })
    await waitFor(() => expect(view.container.textContent).toContain('Sign in to Keith'))
    expect(address.cleared).toBe(1)
  })

  test('an invite link without a code is invalid at once', async () => {
    const fake = start()
    const view = mount(fake, { address: fakeAddress('#invite=') })
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="invite-invalid"]')?.textContent).toBe(INVALID),
    )
  })
})

describe('group threads', () => {
  test('a pushed group joins the list after Main, opens on click, and leaves on thread.removed', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await waitFor(() => expect(threadItems(view).map((b) => b.textContent)).toEqual(['Main']))
    expect(label(view)).toBe('Tony · Main')

    let group = fake.threads[0]
    await act(async () => {
      group = fake.addGroup({ title: 'Mission', purpose: 'Plan the gala', others: [pepper, rhodey] })
    })
    // The group is newer, but Main stays first.
    await waitFor(() =>
      expect(threadItems(view).map((b) => b.textContent)).toEqual(['Main', 'MissionPepper, Rhodey']),
    )
    const item = threadItems(view)[1]
    if (!item || !group) throw new Error('no group item')
    await act(async () => {
      fireEvent.click(item)
    })
    await waitUntil(() => fake.openThreads().includes(group?.id ?? null))
    await online(view)
    const header = view.container.querySelector('[data-slot="group-header"]')
    expect(header?.textContent).toContain('Mission')
    expect(header?.textContent).toContain('Plan the gala')
    expect(header?.querySelector('[data-slot="group-participants"]')?.textContent).toBe(
      'Tony, Pepper, Rhodey',
    )
    expect(label(view)).toBe('Tony · Mission · Pepper, Rhodey')
    expect(threadItems(view)[1]?.getAttribute('aria-current')).toBe('page')

    await act(async () => {
      fake.pushThreadRemoved(group?.id ?? fake.thread.id)
    })
    await waitFor(() => expect(threadItems(view).map((b) => b.textContent)).toEqual(['Main']))
    await waitFor(() => expect(label(view)).toBe('Tony · Main'))
    expect(view.container.querySelector('[data-slot="group-header"]')).toBeNull()
    await waitFor(() => expect(view.container.textContent).toContain('You are no longer in Mission.'))
  })

  test('a thread.updated of the open group refreshes its participants', async () => {
    const fake = start()
    const group = fake.addGroup({ title: 'Mission', others: [pepper] })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    const item = await waitFor(() => {
      const el = threadItems(view)[1]
      if (!el) throw new Error('no group yet')
      return el
    })
    await act(async () => {
      fireEvent.click(item)
    })
    await waitFor(() => expect(view.container.querySelector('[data-slot="group-header"]')).not.toBeNull())
    await act(async () => {
      fake.pushThreadUpdated({ ...group, participants: [...group.participants, rhodey], updatedAt: 99 })
    })
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="group-participants"]')?.textContent).toBe(
        'Tony, Pepper, Rhodey',
      ),
    )
  })

  test('in a group, each person message shows its author; the own ones stay on the right', async () => {
    const fake = start()
    fake.addGroup({
      title: 'Mission',
      others: [pepper],
      messages: [
        { content: 'Venue ideas?', authorPersonId: pepper.id },
        { content: 'Two options.', authorPersonId: null },
        { content: 'The rooftop.', authorPersonId: fake.person.id },
      ],
    })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    const item = await waitFor(() => {
      const el = threadItems(view)[1]
      if (!el) throw new Error('no group yet')
      return el
    })
    await act(async () => {
      fireEvent.click(item)
    })
    await waitFor(() => expect(messages(view)).toHaveLength(3))
    const [fromPepper, fromKeith, fromTony] = messages(view)
    expect(fromPepper?.querySelector('[data-slot="author"]')?.textContent).toBe('Pepper')
    expect(fromPepper?.getAttribute('data-mine')).toBe('false')
    expect(fromPepper?.className).toContain('items-start')
    expect(fromKeith?.querySelector('[data-slot="author"]')).toBeNull()
    expect(fromTony?.querySelector('[data-slot="author"]')?.textContent).toBe('Tony')
    expect(fromTony?.getAttribute('data-mine')).toBe('true')
    expect(fromTony?.className).toContain('items-end')
  })

  test('the main thread shows no author names', async () => {
    const fake = start({ history: 2 })
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await waitFor(() => expect(messages(view)).toHaveLength(2))
    expect(view.container.querySelector('[data-slot="author"]')).toBeNull()
  })

  test('an assistant message with relayFrom shows "via" and the senders', async () => {
    const fake = start()
    const view = mount(fake)
    await signIn(view)
    await online(view)
    await act(async () => {
      await fake.pushProactive('Pepper asks whether you are free on Friday.', {
        relayFrom: [{ personId: pepper.id, name: 'Pepper' }],
      })
      await fake.pushProactive('Two messages for you.', {
        relayFrom: [
          { personId: pepper.id, name: 'Pepper' },
          { personId: rhodey.id, name: 'Rhodey' },
        ],
      })
    })
    await waitFor(() => expect(messages(view, 'assistant')).toHaveLength(2))
    const [one, two] = messages(view, 'assistant')
    expect(one?.querySelector('[data-slot="relay-from"]')?.textContent).toBe('via Pepper')
    expect(two?.querySelector('[data-slot="relay-from"]')?.textContent).toBe('via Pepper, Rhodey')
  })
})
