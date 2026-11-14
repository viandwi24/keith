import { afterEach, describe, expect, test } from 'bun:test'
import { GUEST_BANNER } from '@keith/contracts'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { type FakeGuestOptions, guestHarness } from '../../testing/fake-guest.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { GuestScreen } from './index.ts'

afterEach(cleanup)

const ESC = '\u001b'
const ENTER = '\r'

function show(options: FakeGuestOptions = {}, now = () => Date.now()) {
  const { client, fake } = guestHarness(options)
  const left: string[] = []
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
      <GuestScreen
        client={client}
        columns={100}
        rows={30}
        now={now}
        onLeave={() => left.push('left')}
      />
    </ThemeProvider>,
    { columns: 100 },
  )
  const frame = (): string => stripAnsi(view.lastFrame() ?? '')
  const until = (check: (f: string) => boolean) => frameUntil(frame, check, 4000)
  const press = (key: string, check: (f: string) => boolean) =>
    pressUntil(view.stdin, frame, key, check, { timeoutMs: 4000 })
  // the input takes keys once it is mounted
  const type = async (text: string) => {
    await until((f) => f.includes('ask about the public notes'))
    await Bun.sleep(100)
    view.stdin.write(text)
    await until((f) => f.includes(text))
    view.stdin.write(ENTER)
  }
  return { client, fake, left, view, frame, until, press, type }
}

describe('the guest screen', () => {
  test('shows the banner first, turns left and the expiry, with nothing that needs an account', async () => {
    const t = show()
    const f = await t.until((x) => x.includes('20 of 20 messages left'))
    expect(f).toContain('Guest')
    expect(f).toContain(GUEST_BANNER.slice(0, 40))
    expect(f).toContain('not store')
    expect(f).toContain('owner can watch a live session')
    expect(f).toContain('ends in 2 h')
    expect(f).toContain("Ask about the owner's public notes.")
    expect(f).toContain('[enter] send')
    expect(f).toContain('[esc] end chat')
    // no sidebar items, no panel of an account
    for (const word of ['Tasks', 'Nodes', 'Budget', 'Manage', 'Sign in'])
      expect(f).not.toContain(word)
    expect(t.fake.state.opened).toBe(1)
  })

  test('a message is sent as one text part and the answer streams in; turns left count down', async () => {
    const t = show({ reply: 'The public note says hello.' })
    await t.type('what is public?')
    const f = await t.until(
      (x) => x.includes('The public note says hello.') && x.includes('19 of 20'),
    )
    expect(f).toContain('what is public?')
    expect(t.fake.state.chats).toEqual(['what is public?'])
    // the placeholder of the empty conversation is gone
    expect(f).not.toContain("Ask about the owner's public notes.")
  })

  test('slash commands: only /help and /quit; others are refused locally and never sent', async () => {
    const t = show()
    await t.type('/tasks')
    const f = await t.until((x) => x.includes('not available in guest chat'))
    expect(f).toContain('Try /help')
    await t.type('/help')
    await t.until((x) => x.includes('/quit (or esc) ends the chat'))
    expect(t.fake.state.chats).toEqual([])
    await t.type('/quit')
    await frameUntil(
      () => String(t.left.length),
      (x) => x === '1',
      4000,
    )
    expect(t.fake.state.deleted).toBe(1)
  })

  test('esc ends the session with a DELETE and leaves', async () => {
    const t = show()
    await t.until((x) => x.includes('20 of 20'))
    await Bun.sleep(100)
    await t.press(ESC, () => t.left.length > 0)
    expect(t.fake.state.deleted).toBe(1)
    expect(t.client.session).toBeUndefined()
  })

  test('the last message ends the chat: the input is gone and the message limit is said', async () => {
    const t = show({ maxTurns: 1 })
    await t.type('only one')
    const f = await t.until((x) => x.includes('reached its message limit'))
    expect(f).not.toContain('ask about the public notes')
    expect(f).toContain('[enter] leave')
    t.view.stdin.write(ENTER)
    await frameUntil(
      () => String(t.left.length),
      (x) => x === '1',
      4000,
    )
    // the core ends the session after its grace, so the reason is turn-cap; the client sends no DELETE
    expect(t.fake.state.deleted).toBe(0)
  })

  test('a 410 during a send names the reason and ends the chat', async () => {
    const t = show({ endAt: { turn: 1, reason: 'killed' } })
    await t.type('hello?')
    const f = await t.until((x) => x.includes('The owner turned guest chat off.'))
    expect(f).toContain('[enter] leave')
    // the unanswered assistant message is not left empty on screen
    expect(f).not.toContain('thinking')
  })

  test('the owner watching is told to the visitor', async () => {
    const t = show({ watched: true })
    await t.type('hi')
    await t.until((x) => x.includes('The owner is watching this live chat.'))
  })
})

describe('a chat that cannot start', () => {
  const cases: Array<[NonNullable<FakeGuestOptions['refuseOpen']>, string, boolean]> = [
    [{ code: 'GUEST_DISABLED', status: 403 }, 'Guest chat is not available.', false],
    [{ code: 'GUEST_ZONE', status: 403 }, 'not available from your network', false],
    [
      { code: 'GUEST_RATE_LIMITED', status: 429, retryAfter: 30 },
      'Too many chats were started',
      true,
    ],
    [{ code: 'GUEST_BUSY', status: 429 }, 'Guest chat is busy right now', true],
    [{ code: 'GUEST_CAP', status: 429 }, 'has reached its limit for now', true],
    [{ code: 'GUEST_UNAVAILABLE', status: 503 }, 'not available right now', true],
  ]
  for (const [refuse, text, retry] of cases) {
    test(`${refuse.code}: one clear line, ${retry ? 'enter tries again' : 'enter leaves'}`, async () => {
      const t = show({ refuseOpen: refuse })
      const f = await t.until((x) => x.includes(text))
      expect(f).toContain(retry ? '[enter] try again' : '[enter] leave')
      expect(f).not.toContain('ask about the public notes')
    })
  }
})
