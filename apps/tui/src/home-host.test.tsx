import { afterEach, describe, expect, test } from 'bun:test'
import { BrainTrace, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import type { Approvals } from './features/approvals/index.ts'
import { initialBrain } from './features/brain/brain-state.ts'
import { IDLE_TURN } from './features/home/index.ts'
import type { StepUp } from './features/stepup/index.ts'
import { HomeHost, type HomeHostProps } from './home-host.tsx'
import { stripAnsi } from './testing/ansi.ts'

afterEach(cleanup)

const FAILED = 'Approvals refresh failed: boom'

// no approval waits and no step-up is open: the failed line is the only thing the test is about
const idle = {
  prompt: undefined,
  elevatedUntil: undefined,
} as unknown as StepUp
const none = {
  items: [],
  answerable: [],
  error: undefined,
} as unknown as Approvals

/** Home as the app mounts it, with the connection and the failed refresh chosen by the test. */
function host(over: Partial<HomeHostProps>) {
  const props: HomeHostProps = {
    width: 100,
    rows: 30,
    cellAspect: 0.5,
    trace: new BrainTrace(),
    connection: 'live',
    identity: { status: 'loading' },
    loggedOut: false,
    standalone: false,
    target: 'http://127.0.0.1:7420',
    health: undefined,
    roles: undefined,
    budget: undefined,
    nodes: [],
    tasks: [],
    brain: initialBrain,
    turn: IDLE_TURN,
    typing: false,
    notice: undefined,
    failed: FAILED,
    stepUp: idle,
    approvals: none,
    barHasKeys: false,
    onBarFocus: () => {},
    motion: { intro: false, idleHideSeconds: 0 },
    onChat: () => {},
    onAsk: () => {},
    onAskCommand: () => {},
    onLogin: () => {},
    onStop: () => {},
    onOpen: () => {},
    ...over,
  }
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
      <HomeHost {...props} />
    </ThemeProvider>,
    { columns: props.width, rows: props.rows },
  )
  return { ...view, frame: () => stripAnsi(view.lastFrame() ?? '') }
}

describe('HomeHost: the failed approvals line (A1, tui-design 5.16)', () => {
  test('control: with the core up the failed refresh shows in the caption slot', async () => {
    const v = host({ connection: 'live' })
    await Bun.sleep(40)
    expect(v.frame()).toContain(FAILED)
    v.unmount()
  })

  test('A1: with the core down (link down) the failed-approvals line is not shown', async () => {
    const v = host({ connection: 'disconnected' })
    await Bun.sleep(40)
    expect(v.frame()).toContain('Cannot reach the core')
    expect(v.frame()).not.toContain(FAILED)
    v.unmount()
  })

  test('A1: an offline connection hides it too', async () => {
    const v = host({ connection: 'offline' })
    await Bun.sleep(40)
    expect(v.frame()).not.toContain(FAILED)
    v.unmount()
  })
})
