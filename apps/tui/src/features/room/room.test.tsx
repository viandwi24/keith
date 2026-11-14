import { afterEach, describe, expect, mock, test } from 'bun:test'
import { FooterProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { RoomBannerRow } from './room-banner.tsx'
import { type RoomActions, RoomPane, type RoomPaneProps } from './room-screen.tsx'
import type { RoomViewState, TranscriptLine } from './room-state.ts'

afterEach(cleanup)

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms))

const line = (over: Partial<TranscriptLine>): TranscriptLine => ({
  seq: 1,
  at: 1,
  kind: 'say',
  speaker: 'Ana',
  keith: false,
  body: 'hello',
  ...over,
})

function stateOf(over: Partial<RoomViewState> = {}): RoomViewState {
  return {
    roomId: 'r1',
    name: 'Planning',
    ended: false,
    left: false,
    transcript: [],
    members: [
      { id: 'ana', name: 'Ana', status: 'active', dot: 'online' },
      { id: 'duta', name: 'Duta', status: 'active', dot: 'offline' },
      { id: 'keith', name: 'Keith', status: 'active', dot: 'online' },
    ],
    indicator: undefined,
    confirmation: undefined,
    canSpeak: true,
    canControl: true,
    ...over,
  }
}

function actionsOf(): RoomActions & {
  say: ReturnType<typeof mock>
  leave: ReturnType<typeof mock>
  close: ReturnType<typeof mock>
} {
  return {
    say: mock(async () => {}),
    leave: mock(async () => {}),
    close: mock(() => {}),
  } as never
}

function setup(over: Partial<RoomPaneProps> = {}, columns = 100) {
  const actions = actionsOf()
  const props: RoomPaneProps = {
    state: stateOf(),
    loadError: undefined,
    confirmation: undefined,
    offline: undefined,
    width: columns,
    height: 20,
    active: true,
    actions,
    ...over,
  }
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <FooterProvider>
        <RoomPane {...props} />
      </FooterProvider>
    </ThemeProvider>,
    { columns, rows: 30 },
  )
  return {
    ...view,
    actions,
    rerender: (next: Partial<RoomPaneProps>) =>
      view.rerender(
        <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
          <FooterProvider>
            <RoomPane {...props} {...next} />
          </FooterProvider>
        </ThemeProvider>,
      ),
  }
}

describe('the banner row', () => {
  test('an active room reads with its members and /room', () => {
    const view = render(
      <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
        <RoomBannerRow
          width={80}
          banner={{
            roomId: 'r1',
            tone: 'accent',
            text: '● Room "Planning" · Ana, Duta, Keith · /room',
          }}
        />
      </ThemeProvider>,
      { columns: 80 },
    )
    expect(view.lastFrame()).toContain('● Room "Planning" · Ana, Duta, Keith · /room')
  })
})

describe('the transcript', () => {
  test('names, the K glyph for Keith, system lines and a handoff without text', () => {
    const { lastFrame } = setup({
      state: stateOf({
        transcript: [
          line({ seq: 1, body: 'what should we cook?' }),
          line({ seq: 2, kind: 'keith', speaker: 'Keith', keith: true, body: 'Pasta, maybe.' }),
          line({ seq: 3, kind: 'join', speaker: 'Duta', keith: false, body: 'Duta joined' }),
          line({
            seq: 4,
            kind: 'handoff',
            speaker: 'Ana',
            keith: false,
            body: 'Ana asked in their own chat',
          }),
        ],
      }),
    })
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Ana')
    expect(frame).toContain('what should we cook?')
    expect(frame).toContain(`K Keith`)
    expect(frame).toContain('Pasta, maybe.')
    expect(frame).toContain('· Duta joined')
    expect(frame).toContain('· Ana asked in their own chat')
    expect(frame).toContain('Planning')
  })

  test('the member list shows presence dots and marks an invited member', () => {
    const { lastFrame } = setup({
      state: stateOf({
        members: [
          { id: 'ana', name: 'Ana', status: 'active', dot: 'online' },
          { id: 'duta', name: 'Duta', status: 'invited', dot: 'offline' },
        ],
      }),
    })
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Ana')
    expect(frame).toContain('○ Duta (invited)')
  })

  test('the indicator row shows what Keith or a member is doing', () => {
    const { lastFrame } = setup({ state: stateOf({ indicator: 'Keith is thinking…' }) })
    expect(lastFrame()).toContain('Keith is thinking…')
  })
})

describe('the input line', () => {
  test('a typed line is sent with rooms.say semantics (replyToKeith false when the last line is not Keith)', async () => {
    const { stdin, actions } = setup({ state: stateOf({ transcript: [line({ seq: 1 })] }) })
    await wait()
    for (const ch of 'hi all') stdin.write(ch)
    await wait()
    stdin.write('\r')
    await wait()
    expect(actions.say).toHaveBeenCalledWith('hi all', false)
  })

  test('the last line from Keith makes the next line a reply to Keith', async () => {
    const { stdin, actions } = setup({
      state: stateOf({
        transcript: [
          line({ seq: 2, kind: 'keith', speaker: 'Keith', keith: true, body: 'Pasta?' }),
        ],
      }),
    })
    await wait()
    for (const ch of 'yes') stdin.write(ch)
    await wait()
    stdin.write('\r')
    await wait()
    expect(actions.say).toHaveBeenCalledWith('yes', true)
  })
})

describe('the confirmation bar', () => {
  const confirmation = (answer: (approved: boolean) => Promise<void>) => ({
    question: 'Remove Duta from the room?',
    detail: undefined,
    answer,
  })

  test('shows the question with [y] [n] and the tab hint, unfocused', () => {
    const { lastFrame } = setup({ confirmation: confirmation(async () => {}) })
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Remove Duta from the room? [y] [n]')
    expect(frame).toContain('tab to answer')
  })

  test('a plain y is typed into the input and never answers', async () => {
    const answer = mock(async (_approved: boolean) => {})
    const { stdin, lastFrame } = setup({ confirmation: confirmation(answer) })
    await wait()
    stdin.write('y')
    stdin.write('n')
    await wait()
    expect(answer).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('yn')
  })

  test('after tab, y answers yes; n answers no; the bar gives the keys back after the answer', async () => {
    const answer = mock(async (_approved: boolean) => {})
    const { stdin } = setup({ confirmation: confirmation(answer) })
    await wait()
    stdin.write('\t')
    await wait()
    stdin.write('y')
    await wait()
    expect(answer).toHaveBeenCalledWith(true)
  })

  test('tab then n answers no', async () => {
    const answer = mock(async (_approved: boolean) => {})
    const { stdin } = setup({ confirmation: confirmation(answer) })
    await wait()
    stdin.write('\t')
    await wait()
    stdin.write('n')
    await wait()
    expect(answer).toHaveBeenCalledWith(false)
  })
})

describe('offline and ended rooms', () => {
  test('offline: the input is replaced by the offline hint with the retry key', () => {
    const { lastFrame } = setup({
      offline: 'cannot reach the core (unix:~/.keith/core.sock, connection refused)',
    })
    const frame = lastFrame() ?? ''
    expect(frame).toContain('offline:')
    expect(frame).toContain('[r] retry now')
    expect(frame).toContain('your draft is kept')
  })

  test('an ended room has no input and says so; typing sends nothing', async () => {
    const { stdin, actions, lastFrame } = setup({
      state: stateOf({ ended: true, canSpeak: false, canControl: false }),
    })
    await wait()
    for (const ch of 'hello') stdin.write(ch)
    stdin.write('\r')
    await wait()
    expect(actions.say).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('The room has ended.')
    expect(lastFrame()).toContain('· ended')
  })

  test('a removed or left member has no input and no leave key', () => {
    const { lastFrame } = setup({
      state: stateOf({ left: true, canSpeak: false, canControl: false }),
    })
    expect(lastFrame()).toContain('You are no longer in this room.')
    expect(lastFrame()).not.toContain('[ctrl+l] leave')
  })
})
