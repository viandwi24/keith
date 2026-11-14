import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { BrainTrace, type ColorDepth, MotionProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, manualScheduler, render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { initialBrain } from '../brain/brain-state.ts'
import { resetIntro } from './home-motion.ts'
import { HomeScreen, type HomeScreenProps, IDLE_TURN } from './home-screen.tsx'

beforeEach(resetIntro)
afterEach(cleanup)

const flush = () => new Promise((r) => setTimeout(r, 50))
const trace = new BrainTrace()
const CORE = 'http://127.0.0.1:7420'

/** Home with no intro and no idle hide, so each part is there at once. */
const props = (over: Partial<HomeScreenProps> = {}): HomeScreenProps => ({
  columns: 100,
  rows: 30,
  cellAspect: 0.5,
  running: false,
  active: true,
  motion: { intro: false, idleHideSeconds: 0 },
  trace,
  connection: 'live',
  turn: IDLE_TURN,
  typing: false,
  alert: false,
  chatEnabled: true,
  sections: [],
  summary: {
    me: undefined,
    connection: 'live',
    health: undefined,
    roles: undefined,
    budget: undefined,
    nodes: [],
    tasks: [],
    brain: initialBrain,
  },
  notices: [],
  dialogs: () => null,
  onChat: () => {},
  onLogin: () => {},
  onStop: () => {},
  onOpen: () => {},
  ...over,
})

async function mount(over: Partial<HomeScreenProps> = {}, depth: ColorDepth = 'truecolor') {
  const sched = manualScheduler()
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth })} spinner={false}>
      <MotionProvider scheduler={sched} reduced={false}>
        <HomeScreen {...props(over)} />
      </MotionProvider>
    </ThemeProvider>,
  )
  await flush()
  const frame = () => stripAnsi(view.lastFrame() ?? '')
  const press = async (key: string) => {
    view.stdin.write(key)
    await flush()
  }
  return { ...view, frame, press }
}

const alertAuth = { kind: 'core-down' as const, core: CORE }
const SUBTITLE_WORDS = 'WORDS KEITH SAYS'

describe('the Home caption slot: order and height (tui-design 5.16)', () => {
  test('A2: the alert holds the slot over the first notice and the subtitle', async () => {
    const v = await mount({
      alert: true,
      auth: alertAuth,
      notices: [{ level: 'warning', rows: ['FIRST NOTICE'] }],
      turn: { busy: false, speaking: false, text: SUBTITLE_WORDS },
    })
    const f = v.frame()
    expect(f).toContain('Cannot reach the core at')
    expect(f).not.toContain('FIRST NOTICE')
    expect(f).not.toContain(SUBTITLE_WORDS)
  })

  test('A2: the first notice holds the slot over the subtitle; a second notice waits', async () => {
    const v = await mount({
      notices: [
        { level: 'warning', rows: ['FIRST NOTICE'] },
        { level: 'info', rows: ['SECOND NOTICE'] },
      ],
      turn: { busy: false, speaking: false, text: SUBTITLE_WORDS },
    })
    const f = v.frame()
    expect(f).toContain('FIRST NOTICE')
    expect(f).not.toContain('SECOND NOTICE')
    expect(f).not.toContain(SUBTITLE_WORDS)
  })

  test('A2: with nothing else in the slot the subtitle shows', async () => {
    const v = await mount({ turn: { busy: false, speaking: false, text: SUBTITLE_WORDS } })
    expect(v.frame()).toContain(SUBTITLE_WORDS)
  })

  test('A2: a notice of many rows never takes more than the two caption rows', async () => {
    const v = await mount({
      notices: [{ level: 'warning', rows: ['ROW ONE', 'ROW TWO', 'ROW THREE', 'ROW FOUR'] }],
    })
    const lines = v.frame().split('\n')
    expect(lines.some((l) => l.includes('ROW ONE'))).toBe(true)
    expect(lines.some((l) => l.includes('ROW TWO'))).toBe(true)
    expect(lines.some((l) => l.includes('ROW THREE'))).toBe(false)
    // the legend keeps its row: the caption never pushed it down
    const legend = lines.findIndex((l) => /\[(enter|space)\]/.test(l))
    expect(legend).toBe(30 - 2)
  })
})

describe('the Home room banner (A3, tui-design 5.16)', () => {
  const banner = { roomId: 'room-1', tone: 'accent' as const, text: 'ROOM BANNER TEXT' }

  test('A3: the banner takes an idle caption slot', async () => {
    const v = await mount({ banner })
    expect(v.frame()).toContain('ROOM BANNER TEXT')
  })

  test('A3: an alert with no auth (locked or offline) keeps the banner out of the slot', async () => {
    // `alert` alone (no caption, no heir, no notice): the banner must not take the slot the alert state owns
    const v = await mount({ banner, alert: true })
    expect(v.frame()).not.toContain('ROOM BANNER TEXT')
    v.unmount()
  })

  test('A3: a running turn gives the slot to the subtitle, not the banner', async () => {
    const v = await mount({
      banner,
      turn: { busy: true, speaking: true, text: SUBTITLE_WORDS },
    })
    const f = v.frame()
    expect(f).not.toContain('ROOM BANNER TEXT')
    expect(f).toContain(SUBTITLE_WORDS)
  })

  test('A3: a notice, the heir line or the alert holds the slot over the banner', async () => {
    const withNotice = await mount({
      banner,
      notices: [{ level: 'info', rows: ['A NOTICE'] }],
    })
    expect(withNotice.frame()).toContain('A NOTICE')
    expect(withNotice.frame()).not.toContain('ROOM BANNER TEXT')
    withNotice.unmount()

    const withHeir = await mount({
      banner,
      heir: { text: 'HEIR LINE', tone: 'muted' },
    })
    expect(withHeir.frame()).toContain('HEIR LINE')
    expect(withHeir.frame()).not.toContain('ROOM BANNER TEXT')
    withHeir.unmount()

    const withAlert = await mount({ banner, alert: true, auth: alertAuth })
    expect(withAlert.frame()).toContain('Cannot reach the core at')
    expect(withAlert.frame()).not.toContain('ROOM BANNER TEXT')
    withAlert.unmount()
  })
})

describe('the Home menu and the quick ask (A6, A7, tui-design 5.16)', () => {
  test('A6: reopening the menu starts at the top level, with the top selection', async () => {
    const v = await mount()
    await v.press(' ')
    await flush()
    expect(v.frame()).toContain('▸ System')
    // move the selection down to Help, close, reopen: the top level and its first row again
    await v.press('j')
    expect(v.frame()).toContain('▸ Help')
    await v.press(' ')
    expect(v.frame()).not.toContain('▸ Help')
    await v.press(' ')
    expect(v.frame()).toContain('▸ System')
    expect(v.frame()).not.toContain('▸ Help')
    v.unmount()
  })

  test('A6: a submenu left open is not kept: the next open shows the top level again', async () => {
    const v = await mount()
    await v.press(' ')
    await v.press('\r')
    // the group's submenu: its entries show, the group title is the first row
    expect(v.frame()).toContain('Brain trace')
    await v.press(' ')
    await v.press(' ')
    expect(v.frame()).not.toContain('Brain trace')
    expect(v.frame()).toContain('▸ System')
    v.unmount()
  })

  test('A7: the quick ask line is at most 76 columns wide', async () => {
    const v = await mount({ askEnabled: true, columns: 100 })
    await v.press('\t')
    const line = v
      .frame()
      .split('\n')
      .find((l) => l.includes('ask keith'))
    expect(line).toBeDefined()
    expect(Bun.stringWidth(line?.trim() ?? '')).toBeLessThanOrEqual(76)
    v.unmount()
  })
})

describe('one frame clock per screen (A8, tui-design 5.16 Clock)', () => {
  test('the orb, the brain frame and the subtitle share one interval timer', async () => {
    const spy = spyOn(globalThis, 'setInterval')
    try {
      const before = spy.mock.calls.length
      const v = await mount(
        { running: true, turn: { busy: true, speaking: true, text: SUBTITLE_WORDS } },
        'truecolor',
      )
      await flush()
      // the Home clock is the only interval: the orb, the frame and the subtitle take it
      expect(spy.mock.calls.length - before).toBe(1)
      v.unmount()
    } finally {
      spy.mockRestore()
    }
  })
})
