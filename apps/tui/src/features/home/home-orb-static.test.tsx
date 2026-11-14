import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BrainTrace, MotionProvider, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { initialBrain } from '../brain/brain-state.ts'
import { type HomeMotion, resetIntro } from './home-motion.ts'
import { HomeScreen, type HomeScreenProps, IDLE_TURN } from './home-screen.tsx'
import { homeSize } from './home-state.ts'

beforeEach(resetIntro)
afterEach(cleanup)

const TRUECOLOR = resolveTheme({ theme: 'dark', depth: 'truecolor' })
const trace = new BrainTrace()
const NO_INTRO: HomeMotion = { intro: false, idleHideSeconds: 0 }
const wait = (ms: number) => Bun.sleep(ms)

// wide enough that the brain frame (left, 44 columns at most) and the orb do not share columns
const COLUMNS = 200
const ROWS = 40
const SIZE = homeSize(COLUMNS, ROWS, 0.5)

/** The cells of the orb alone, plain text (`withColour`: the escape codes too). */
function orbArea(frame: string, withColour = false): string {
  const lines = frame.split('\n').slice(SIZE.orbTop, SIZE.orbTop + SIZE.orbHeight)
  const cut = lines.map((l) => {
    const plain = stripAnsi(l)
    // the orb's columns; with colour the escape codes of those cells are kept in order
    return withColour ? l : [...plain].slice(SIZE.orbLeft, SIZE.orbLeft + SIZE.orbWidth).join('')
  })
  return cut.join('\n')
}

const props = (over: Partial<HomeScreenProps> = {}): HomeScreenProps => ({
  columns: COLUMNS,
  rows: ROWS,
  cellAspect: 0.5,
  running: true,
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
  motion: NO_INTRO,
  ...over,
})

/** Home with its own clock running (as in the app), under the still flag or not. */
function home(over: Partial<HomeScreenProps>, orbStatic: boolean) {
  return (
    <ThemeProvider theme={TRUECOLOR}>
      <MotionProvider orbStatic={orbStatic}>
        <HomeScreen {...props(over)} />
      </MotionProvider>
    </ThemeProvider>
  )
}

describe('Home with --disable-orb', () => {
  test('the orb is a fixed picture: its cells are identical across ticks of the clock', async () => {
    const view = render(home({}, true), { columns: COLUMNS, rows: ROWS })
    await wait(60)
    const first = orbArea(view.lastFrame() ?? '')
    expect(first).toMatch(/[⠁-⣿]/)
    // Home's clock runs (the brain frame keeps moving) while the orb stays
    await wait(500)
    expect(view.frames.length).toBeGreaterThan(3)
    expect(orbArea(view.lastFrame() ?? '')).toBe(first)
    cleanup()
  })

  test('the orb colour follows the state: a lost core is another colour, the same shape', async () => {
    const view = render(home({}, true), { columns: COLUMNS, rows: ROWS })
    await wait(60)
    const live = view.lastFrame() ?? ''
    view.rerender(home({ alert: true }, true))
    await wait(60)
    const alert = view.lastFrame() ?? ''
    expect(alert).not.toBe(live)
    expect(orbArea(alert)).toBe(orbArea(live))
    cleanup()
  })

  test('without the flag the orb keeps moving', async () => {
    const view = render(home({}, false), { columns: COLUMNS, rows: ROWS })
    await wait(60)
    const first = orbArea(view.lastFrame() ?? '')
    await wait(600)
    expect(orbArea(view.lastFrame() ?? '')).not.toBe(first)
    cleanup()
  })
})

describe('the still orb has no intro', () => {
  test('the orb is drawn at once with the flag, even when the intro is on', async () => {
    resetIntro()
    const view = render(home({ motion: { intro: true, idleHideSeconds: 0 } }, true), {
      columns: COLUMNS,
      rows: ROWS,
    })
    await wait(30)
    expect(orbArea(view.lastFrame() ?? '')).toMatch(/[⠁-⣿]/)
    cleanup()
  })
})
