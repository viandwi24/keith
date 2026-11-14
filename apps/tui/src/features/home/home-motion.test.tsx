import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BrainTrace,
  type ColorDepth,
  MotionProvider,
  resolveTheme,
  type Scheduler,
  ThemeProvider,
} from '@keith/ui'
import { cleanup, manualScheduler, render } from '@keith/ui/testing'
import { Text, useInput } from 'ink'
import { stripAnsi } from '../../testing/ansi.ts'
import { initialBrain } from '../brain/brain-state.ts'
import { type HomeMotion, resetIntro } from './home-motion.ts'
import { HomeScreen, type HomeScreenProps, IDLE_TURN } from './home-screen.tsx'

beforeEach(resetIntro)
afterEach(cleanup)

const flush = () => new Promise((r) => setTimeout(r, 50))
const trace = new BrainTrace()

const props = (over: Partial<HomeScreenProps> = {}): HomeScreenProps => ({
  columns: 100,
  rows: 30,
  cellAspect: 0.5,
  running: false,
  active: true,
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

const tree = (
  p: HomeScreenProps,
  sched: Scheduler,
  { depth = 'truecolor', reduced = false }: { depth?: ColorDepth; reduced?: boolean } = {},
  sibling?: (input: string) => void,
) => (
  <ThemeProvider theme={resolveTheme({ theme: 'dark', depth })}>
    <MotionProvider scheduler={sched} reduced={reduced}>
      <HomeScreen {...p} />
      {sibling && <Sibling onKey={sibling} />}
    </MotionProvider>
  </ThemeProvider>
)

function Sibling({ onKey }: { onKey(input: string): void }) {
  useInput((input, key) => onKey(key.ctrl ? `ctrl+${input}` : input))
  return <Text> </Text>
}

const NO_INTRO: HomeMotion = { intro: false, idleHideSeconds: 0 }

async function mount(
  over: Partial<HomeScreenProps>,
  opts?: Parameters<typeof tree>[2],
  sibling?: (input: string) => void,
) {
  const sched = manualScheduler()
  const view = render(tree(props(over), sched, opts, sibling))
  await flush()
  const frame = () => stripAnsi(view.lastFrame() ?? '')
  const press = async (key: string) => {
    view.stdin.write(key)
    await flush()
  }
  const advance = async (ms: number) => {
    sched.advance(ms)
    await flush()
  }
  return { ...view, sched, frame, press, advance }
}

const has = {
  title: (f: string) => f.includes('K E I T H'),
  legend: (f: string) => f.includes('[enter] chat'),
  graph: (f: string) => f.includes('╭─'),
}

describe('Home intro', () => {
  test('reveals the graph, then the legend, then the title, in sequence', async () => {
    const v = await mount({ motion: { intro: true, idleHideSeconds: 0 } })
    let f = v.frame()
    expect(has.graph(f) || has.legend(f) || has.title(f)).toBe(false)
    await v.advance(450)
    f = v.frame()
    expect(has.graph(f)).toBe(true)
    expect(has.legend(f)).toBe(false)
    expect(has.title(f)).toBe(false)
    await v.advance(300)
    f = v.frame()
    expect(has.legend(f)).toBe(true)
    expect(has.title(f)).toBe(false)
    await v.advance(700)
    f = v.frame()
    expect(has.graph(f) && has.legend(f) && has.title(f)).toBe(true)
    // the whole intro is over in about a second and a quarter, and no timer is left running
    expect(v.sched.active()).toBe(0)
  })

  test('any key skips it at once (and still does its own job)', async () => {
    let chats = 0
    const v = await mount({ motion: { intro: true, idleHideSeconds: 0 }, onChat: () => chats++ })
    expect(has.title(v.frame())).toBe(false)
    await v.press('\r')
    const f = v.frame()
    expect(has.graph(f) && has.legend(f) && has.title(f)).toBe(true)
    expect(chats).toBe(1)
    expect(v.sched.active()).toBe(0)
  })

  test('plays only for the first Home of the process', async () => {
    const first = await mount({ motion: { intro: true, idleHideSeconds: 0 } })
    expect(has.title(first.frame())).toBe(false)
    first.unmount()
    const again = await mount({ motion: { intro: true, idleHideSeconds: 0 } })
    const f = again.frame()
    expect(has.graph(f) && has.legend(f) && has.title(f)).toBe(true)
    expect(again.sched.active()).toBe(0)
  })

  test('no colour, reduced motion or `intro: false`: everything is there at once', async () => {
    for (const [opts, motion] of [
      [{ depth: 'none' as const }, { intro: true, idleHideSeconds: 0 }],
      [{ reduced: true }, { intro: true, idleHideSeconds: 0 }],
      [{}, NO_INTRO],
    ] as const) {
      resetIntro()
      const v = await mount({ motion }, opts)
      const f = v.frame()
      expect(has.graph(f) && has.legend(f) && has.title(f)).toBe(true)
      expect(v.sched.active()).toBe(0)
      v.unmount()
    }
  })
})

describe('Home auto-hide', () => {
  const idle = (seconds: number): HomeMotion => ({ intro: false, idleHideSeconds: seconds })

  test('after the idle time the parts fade out and the orb stays; a timer exists only while armed', async () => {
    const v = await mount({ motion: idle(5) }, { depth: 'none' })
    expect(has.title(v.frame())).toBe(true)
    expect(v.sched.active()).toBe(1)
    await v.advance(4900)
    expect(has.title(v.frame())).toBe(true)
    await v.advance(200)
    const f = v.frame()
    expect(has.title(f) || has.legend(f) || has.graph(f)).toBe(false)
    expect(f).toContain('● idle')
    expect(v.sched.active()).toBe(0)
  })

  test('with colour the fade-out is gradual and its clock stops when it settled', async () => {
    const v = await mount({ motion: idle(5) })
    await v.advance(5000)
    // the graph, the legend and the title each run one fade timer
    expect(v.sched.active()).toBe(3)
    await v.advance(150)
    expect(has.title(v.frame())).toBe(true)
    await v.advance(400)
    expect(has.title(v.frame())).toBe(false)
    expect(v.sched.active()).toBe(0)
  })

  test('the waking key is swallowed, the next one acts', async () => {
    let chats = 0
    const v = await mount({ motion: idle(5), onChat: () => chats++ }, { depth: 'none' })
    await v.advance(5100)
    expect(has.title(v.frame())).toBe(false)
    await v.press('\r')
    expect(chats).toBe(0)
    expect(has.title(v.frame()) && has.legend(v.frame())).toBe(true)
    await v.press('\r')
    expect(chats).toBe(1)
  })

  test('with colour the wake fades back in, then nothing runs', async () => {
    const v = await mount({ motion: idle(5) })
    await v.advance(5000)
    await v.advance(1000)
    expect(has.legend(v.frame())).toBe(false)
    await v.press('x')
    await v.advance(500)
    expect(has.legend(v.frame()) && has.title(v.frame()) && has.graph(v.frame())).toBe(true)
    // armed again for the next pause: exactly one timer, no animation left
    expect(v.sched.active()).toBe(1)
  })

  test('ctrl+c is never swallowed', async () => {
    const seen: string[] = []
    const v = await mount({ motion: idle(5) }, { depth: 'none' }, (k) => seen.push(k))
    await v.advance(5100)
    await v.press('\u0003')
    expect(seen).toContain('ctrl+c')
    expect(has.title(v.frame())).toBe(true)
  })

  test('a key resets the timer', async () => {
    const v = await mount({ motion: idle(5) }, { depth: 'none' })
    await v.advance(4000)
    await v.press('x')
    await v.advance(4000)
    expect(has.title(v.frame())).toBe(true)
    await v.advance(1100)
    expect(has.title(v.frame())).toBe(false)
  })

  test('0 turns it off', async () => {
    const v = await mount({ motion: idle(0) }, { depth: 'none' })
    expect(v.sched.active()).toBe(0)
    await v.advance(3_600_000)
    expect(has.title(v.frame())).toBe(true)
  })

  test('an approval, dialog, login panel, notice or error keeps everything shown', async () => {
    const cases: Partial<HomeScreenProps>[] = [
      { attention: true },
      { panel: () => <Text>login here</Text> },
      { alert: true },
      { notices: [{ level: 'warning', rows: ['approvals failed'] }] },
      { turn: { busy: true, speaking: false, text: '' } },
    ]
    for (const over of cases) {
      const v = await mount({ motion: idle(5), ...over }, { depth: 'none' })
      await v.advance(60_000)
      expect(has.title(v.frame())).toBe(true)
      expect(v.sched.active()).toBe(0)
      v.unmount()
    }
  })

  test('attention that appears resets the timer and brings a hidden Home back; leaving re-arms', async () => {
    const sched = manualScheduler()
    const view = render(tree(props({ motion: idle(5) }), sched, { depth: 'none' }))
    await flush()
    sched.advance(5100)
    await flush()
    expect(has.title(stripAnsi(view.lastFrame() ?? ''))).toBe(false)
    view.rerender(tree(props({ motion: idle(5), attention: true }), sched, { depth: 'none' }))
    await flush()
    expect(has.title(stripAnsi(view.lastFrame() ?? ''))).toBe(true)
    sched.advance(60_000)
    await flush()
    expect(has.title(stripAnsi(view.lastFrame() ?? ''))).toBe(true)
    view.rerender(tree(props({ motion: idle(5) }), sched, { depth: 'none' }))
    await flush()
    sched.advance(5100)
    await flush()
    expect(has.title(stripAnsi(view.lastFrame() ?? ''))).toBe(false)
  })

  test('reduced motion hides and shows at once, with no animation timer', async () => {
    const v = await mount({ motion: idle(5) }, { reduced: true })
    await v.advance(5000)
    expect(has.title(v.frame())).toBe(false)
    expect(v.sched.active()).toBe(0)
  })
})
