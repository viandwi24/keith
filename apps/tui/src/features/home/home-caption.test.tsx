import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from '@keith/ui/testing'
import { App } from '../../app.tsx'
import { stripAnsi } from '../../testing/ansi.ts'
import { startFakeCore } from '../../testing/fake-core.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 100, rows: 30 },
  { columns: 120, rows: 40 },
] as const
const BRAILLE = /[⠁-⣿]/u

type State = 'idle' | 'menu' | 'core-down' | 'logged-out' | 'notice'

/** Home in truecolor (the orb is braille), in one of its states; the frame is plain text. */
async function open(state: State, columns: number, rows: number) {
  const core = startFakeCore({
    rpc: {
      'health/get': () => ({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot: 'b' }),
      'models/roles/get': () => ({ front: null, cortex: null }),
      'tasks/list': () => [],
      'nodes/list': () => [],
      ...(state === 'notice' ? { 'approvals/list': () => Promise.reject(new Error('boom')) } : {}),
    },
  })
  if (state === 'logged-out') core.revoke()
  const client = createKeithClient({
    baseUrl: state === 'core-down' ? 'http://127.0.0.1:1' : core.url,
    token: 't',
  })
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'truecolor' })} spinner={false}>
      <App client={client} core={core.url} columns={columns} rows={rows} start="home" />
    </ThemeProvider>,
    { columns, rows },
  )
  const frame = () => stripAnsi(view.lastFrame() ?? '')
  const wait: Record<State, string> = {
    idle: 'K E I T H',
    menu: 'K E I T H',
    'core-down': 'Cannot reach the core',
    'logged-out': 'Signed out',
    notice: 'K E I T H',
  }
  await frameUntil(frame, (f) => f.includes(wait[state]))
  await Bun.sleep(200)
  if (state === 'menu') await pressUntil(view.stdin, frame, ' ', (f) => f.includes('▸ Overview'))
  return { ...view, frame, stop: () => core.stop() }
}

/** Where the orb is: the braille cells below the brain frame (rows 9 and down). */
function orbBox(frame: string): { top: number; bottom: number; left: number; right: number } {
  let top = Number.POSITIVE_INFINITY
  let bottom = -1
  let left = Number.POSITIVE_INFINITY
  let right = -1
  frame.split('\n').forEach((row, y) => {
    if (y < 9) return
    for (const [x, ch] of [...row].entries()) {
      if (!BRAILLE.test(ch)) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
  })
  return { top, bottom, left, right }
}

describe('the Home caption slot', () => {
  test.each(SIZES)(
    'the orb keeps its size and place whatever the caption says ($columns x $rows)',
    async ({ columns, rows }) => {
      const states: State[] = ['idle', 'menu', 'core-down', 'logged-out', 'notice']
      const boxes: Record<string, ReturnType<typeof orbBox>> = {}
      for (const state of states) {
        const view = await open(state, columns, rows)
        const text = view.frame()
        boxes[state] = orbBox(text)
        const lines = text.split('\n')
        // nothing wider than the terminal, never taller than the terminal
        expect(lines.length).toBeLessThanOrEqual(rows)
        for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
        // the legend, the blank row above it and two caption rows: the same place in every state
        const legend = lines.findIndex((l) => /\[(enter|space)\]/.test(l))
        expect(legend).toBe(rows - 2)
        if (state !== 'menu') expect(lines[legend - 1]?.trim()).toBe('')
        view.unmount()
        view.stop()
      }
      const idle = boxes.idle
      for (const state of states) {
        // the orb's extent moves by at most a row or two of drifting particles, never by a caption
        const box = boxes[state]
        expect(Math.abs((box?.top ?? 0) - (idle?.top ?? 99))).toBeLessThanOrEqual(1)
        expect(Math.abs((box?.right ?? 0) - (idle?.right ?? 99))).toBeLessThanOrEqual(2)
        // the menu is an overlay on the lower left: it may hide the orb there, never resize it
        if (state === 'menu') continue
        expect(Math.abs((box?.bottom ?? 0) - (idle?.bottom ?? 99))).toBeLessThanOrEqual(1)
        expect(Math.abs((box?.left ?? 0) - (idle?.left ?? 99))).toBeLessThanOrEqual(2)
      }
    },
    60_000,
  )

  test('core down at 100x30: one caption row (the error), no frame, the legend below', async () => {
    const view = await open('core-down', 100, 30)
    const lines = view.frame().split('\n')
    const at = lines.findIndex((l) => l.includes('Cannot reach the core'))
    expect(lines[at + 1]?.trim()).toBe('')
    expect(lines.join('\n')).not.toContain('Core down')
    expect(lines.join('\n')).not.toContain('╭─ Core')
    view.unmount()
    view.stop()
  })
})
