import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from '@keith/ui/testing'
import { App } from '../../app.tsx'
import { DEFAULT_CELL_ASPECT } from '../../platform/cell-size.ts'
import { stripAnsi } from '../../testing/ansi.ts'
import { type FakeCoreOptions, startFakeCore } from '../../testing/fake-core.ts'
import { approval } from '../../testing/fixtures.ts'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { stopCores } from '../../testing/setup-app.tsx'
import { homeSize } from './home-state.ts'

afterEach(stopCores)

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 100, rows: 30 },
  { columns: 120, rows: 40 },
  { columns: 160, rows: 50 },
  { columns: 60, rows: 16 },
] as const
const BRAILLE = /[⠁-⣿]/u

interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/** The braille cells below the brain frame (row 9 down; the frame is above the orb's lower part). */
function paintedBox(frame: string, fromRow: number): Box {
  const box = {
    top: Number.POSITIVE_INFINITY,
    bottom: -1,
    left: Number.POSITIVE_INFINITY,
    right: -1,
  }
  frame.split('\n').forEach((row, y) => {
    if (y < fromRow) return
    for (const [x, ch] of [...row].entries()) {
      if (!BRAILLE.test(ch)) continue
      box.top = Math.min(box.top, y)
      box.bottom = Math.max(box.bottom, y)
      box.left = Math.min(box.left, x)
      box.right = Math.max(box.right, x)
    }
  })
  return box
}

async function openHome(
  columns: number,
  rows: number,
  options: FakeCoreOptions & { down?: boolean; revoked?: boolean } = {},
) {
  const { down, revoked, ...coreOptions } = options
  const core = startFakeCore({
    ...coreOptions,
    rpc: {
      'health/get': () => ({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot: 'b' }),
      'models/roles/get': () => ({ front: null, cortex: null }),
      'tasks/list': () => [],
      'nodes/list': () => [],
      ...coreOptions.rpc,
    },
  })
  if (revoked) core.revoke()
  const client = createKeithClient({ baseUrl: down ? 'http://127.0.0.1:1' : core.url, token: 't' })
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'truecolor' })} spinner={false}>
      <App client={client} core={core.url} columns={columns} rows={rows} start="home" />
    </ThemeProvider>,
    { columns, rows },
  )
  const frame = () => stripAnsi(view.lastFrame() ?? '')
  await frameUntil(frame, (f) => f.includes('K E I T H'))
  await Bun.sleep(200)
  return {
    ...view,
    frame,
    core,
    close: () => {
      view.unmount()
      core.stop()
    },
  }
}

/** Measures every frame taken in a state against the box `homeSize` promises. */
function recorder(columns: number, rows: number) {
  const size = homeSize(columns, rows, DEFAULT_CELL_ASPECT)
  const top = size.orbTop
  const bottom = size.orbTop + size.orbHeight - 1
  const left = size.orbLeft
  const right = size.orbLeft + size.orbWidth - 1
  const boxes: { state: string; box: Box; overlay: boolean }[] = []
  return {
    size,
    /** `overlay`: a dialog or the menu covers part of the orb; it may hide cells, never move or grow it. */
    take(state: string, frame: string, overlay = false) {
      const lines = frame.split('\n')
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
      // the frame (brain trace) covers the orb's top-left rows; measure below it
      const from = size.frame ? 9 : 0
      const box = paintedBox(frame, from)
      if (box.bottom >= 0) {
        // nothing painted outside the promised box: never taller, shorter-placed, wider or shifted
        expect(box.bottom).toBeLessThanOrEqual(bottom)
        expect(box.left).toBeGreaterThanOrEqual(left)
        expect(box.right).toBeLessThanOrEqual(right)
        expect(box.top).toBeGreaterThanOrEqual(Math.max(top, from))
      }
      boxes.push({ state, box, overlay })
    },
    /** Every non-overlay state paints the same extent (drifting particles move it by 2 cells at most). */
    verify() {
      const plain = boxes.filter((b) => !b.overlay && b.box.bottom >= 0)
      if (plain.length === 0) return
      const first = plain[0]?.box as Box
      for (const { state, box } of plain) {
        const where = `${state} @${columns}x${rows}`
        expect([where, Math.abs(box.bottom - first.bottom) <= 2]).toEqual([where, true])
        expect([where, Math.abs(box.top - first.top) <= 2]).toEqual([where, true])
        expect([where, Math.abs(box.left - first.left) <= 3]).toEqual([where, true])
        expect([where, Math.abs(box.right - first.right) <= 3]).toEqual([where, true])
      }
      // the orb really uses the box (it is drawn, not collapsed)
      expect(first.bottom).toBeGreaterThanOrEqual(bottom - 3)
      expect(first.right - first.left).toBeGreaterThanOrEqual((right - left) * 0.6)
    },
  }
}

describe('homeSize invariance', () => {
  test('the orb box depends on columns, rows and the cell aspect only, and the slot holds it', () => {
    for (const { columns, rows } of SIZES) {
      const a = homeSize(columns, rows, DEFAULT_CELL_ASPECT)
      const b = homeSize(columns, rows, DEFAULT_CELL_ASPECT)
      expect(a).toEqual(b)
      // the orb sits inside its slot with room to spare under it on a screen with the subtitle
      expect(a.orbTop - 3 + a.orbHeight).toBeLessThanOrEqual(a.areaRows)
      if (a.subtitle) expect(a.orbTop - 3 + a.orbHeight).toBeLessThan(a.areaRows)
      expect(a.orbLeft + a.orbWidth).toBeLessThanOrEqual(columns)
    }
  })
})

describe('the Home orb keeps one size in every state', () => {
  test.each(SIZES)(
    'idle, quick ask, listening, thinking, speaking, menu ($columns x $rows)',
    async ({ columns, rows }) => {
      const rec = recorder(columns, rows)
      const reply = 'Hello from Keith. '.repeat(12)
      const view = await openHome(columns, rows, { reply })
      rec.take('idle', view.frame())
      const legend = rows - 2
      const place = (f: string) =>
        f.split('\n').findIndex((l) => /\[(enter|space|esc|tab)\]/.test(l))
      expect(place(view.frame())).toBe(legend)

      await pressUntil(view.stdin, view.frame, '\t', (f) => f.includes('ask keith…'))
      rec.take('ask open', view.frame())
      expect(place(view.frame())).toBe(legend)
      for (const ch of 'hi') view.stdin.write(ch)
      await frameUntil(view.frame, (f) => f.includes('hi'))
      rec.take('listening', view.frame())
      view.stdin.write('\r')
      // sample the whole turn: thinking, speaking, the subtitle at 1 then 2 rows, then holding
      const started = Date.now()
      let sawReply = false
      while (Date.now() - started < 1500) {
        const f = view.frame()
        if (f.includes('Hello from Keith')) sawReply = true
        rec.take('turn', f)
        expect(place(f)).toBe(legend)
        await Bun.sleep(40)
      }
      expect(sawReply).toBe(true)
      await pressUntil(view.stdin, view.frame, '\u001b', (f) => !f.includes('ask keith…'))
      rec.take('ask closed', view.frame())

      await pressUntil(view.stdin, view.frame, ' ', (f) => f.includes('▸ Overview'))
      rec.take('menu', view.frame(), true)
      await pressUntil(view.stdin, view.frame, '\r', (f) => f.includes('╭─ Overview'))
      rec.take('menu detail', view.frame(), true)
      await pressUntil(view.stdin, view.frame, '\u001b', (f) => !f.includes('▸ '))
      await Bun.sleep(100)
      rec.take('menu closed', view.frame())
      rec.verify()
      view.close()
    },
    60_000,
  )

  test.each(SIZES)(
    'a pending approval and the step-up dialog overlay the orb ($columns x $rows)',
    async ({ columns, rows }) => {
      const rec = recorder(columns, rows)
      const view = await openHome(columns, rows, {
        attention: [approval({ id: 'ap1' })],
        stepUp: { required: true },
      })
      await frameUntil(view.frame, (f) => f.includes('Approval needed'))
      rec.take('approval', view.frame(), true)
      await pressUntil(view.stdin, view.frame, '\t', (f) => f.includes('[y] allow'))
      await pressUntil(view.stdin, view.frame, 'y', (f) => f.includes("Confirm it's you"))
      rec.take('step-up', view.frame(), true)
      rec.verify()
      view.close()
    },
    60_000,
  )

  test.each(SIZES)(
    'a notice, core down and logged out ($columns x $rows)',
    async ({ columns, rows }) => {
      const rec = recorder(columns, rows)
      const base = await openHome(columns, rows)
      rec.take('idle', base.frame())
      base.close()

      const notice = await openHome(columns, rows, {
        rpc: { 'approvals/list': () => Promise.reject(new Error('boom')) },
      })
      await Bun.sleep(300)
      rec.take('notice', notice.frame())
      notice.close()

      const down = await openHome(columns, rows, { down: true })
      await frameUntil(down.frame, (f) => f.includes('Cannot reach the core'))
      rec.take('core down', down.frame())
      down.close()

      const out = await openHome(columns, rows, { revoked: true })
      await frameUntil(out.frame, (f) => f.includes('Signed out'))
      rec.take('logged out', out.frame())
      out.close()
      rec.verify()
    },
    60_000,
  )
})
