import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cells } from '@keith/ui'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { DOWN, ESC, ORDER } from './testing/manage-helpers.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(60_000)

const WIDTHS = [60, 80, 100, 120] as const

/** The legend line of Manage: the last row that starts with a `[key]` pair. */
const legendOf = (frame: string): string =>
  frame
    .split('\n')
    .filter((l) => /^ {2}\[[^\]]+\] /.test(l))
    .at(0) ?? ''

async function open(columns: number, rows = 30) {
  const app = await setupApp({ admin: createFakeAdmin(), start: 'manage', columns, rows })
  await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
  return app
}

describe('the look of Manage (two panes)', () => {
  test('the list is plain rows, the section is a framed pane with n/N, one legend below', async () => {
    const app = await open(120, 30)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('╭─ Manage ─╮')
    expect(frame).toContain('K E I T H')
    // the list: the selection marked with ▸, nothing around it
    const list = frame.split('\n').filter((l) => /^ {2}( {2}|▸ )[A-Z]/.test(l))
    expect(list.length).toBe(ORDER.length)
    expect(list[0]).toContain('▸ Overview')
    expect(list[1]).not.toContain('▸')
    expect(frame).toContain('╭─ Overview ─')
    expect(frame).toContain(`1/${ORDER.length} ─╮`)
    // facts: the key dim and aligned, then the value
    expect(frame).toMatch(/│ people {4}3 /)
    expect(legendOf(frame)).toContain('[↑↓] section')
    expect(legendOf(frame)).toContain('[esc] back')
    app.unmount()
  })

  test('rows: a dim header, aligned columns, status glyph plus word, ▸ on the selection, [n] named in the legend', async () => {
    const app = await open(120, 30)
    await pressUntil(app.stdin, app.lastFrame, DOWN, (f) => f.includes('▸ People'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('[enter] actions'))
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('suspended'))
    expect(frame).toContain('╭─ People ─')
    expect(frame).toContain(`2/${ORDER.length} ─╮`)
    const lines = frame.split('\n')
    const header = lines.find((l) => l.includes('USERNAME')) ?? ''
    const first = lines.find((l) => l.includes('│ ▸ ')) ?? ''
    // the header starts where the rows' text starts
    expect(header.indexOf('USERNAME')).toBe(first.indexOf('│ ▸ ') + 4)
    expect(frame).toContain('● active')
    expect(frame).toContain('◐ suspended')
    expect(legendOf(frame)).toContain('[n] add a person')
    expect(legendOf(frame)).toContain('[enter] actions')
    app.unmount()
  })

  test('a dialog is its own frame in the pane (no frame inside a frame) and the legend becomes its keys', async () => {
    const app = await open(120, 30)
    await pressUntil(app.stdin, app.lastFrame, DOWN, (f) => f.includes('▸ People'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('[enter] actions'))
    const frame = await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Add a person'))
    expect(frame).toContain('╭─ Add a person ─')
    expect(frame).not.toContain('╭─ People ─')
    expect(frame.match(/╭/g)?.length).toBe(2) // the Manage tag and the dialog
    expect(legendOf(frame)).toContain('[enter] next')
    expect(legendOf(frame)).toContain('[esc] cancel')
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('╭─ People ─'))
    app.unmount()
  })

  test('a loading section shows the pulse and the word, not a spinner line of text only', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({
      admin,
      start: 'manage',
      columns: 120,
      rows: 30,
      rpc: { 'health/get': () => new Promise(() => {}) },
    })
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('loading'))
    expect(frame).toMatch(/[✳·✢✶✻✽] loading/)
    app.unmount()
  })
})

describe('no row is wider than the terminal; the legend is never cut', () => {
  for (const columns of WIDTHS) {
    test(`every section at ${columns} columns`, async () => {
      const app = await open(columns)
      const wide = columns >= 100
      for (const [i, title] of ORDER.entries()) {
        if (i > 0)
          await pressUntil(
            app.stdin,
            app.lastFrame,
            wide ? DOWN : '\t',
            (f) => f.includes(`╭─ ${title} ─`) || f.includes(`▸ ${title}`),
          )
        const frame = await frameUntil(
          app.lastFrame,
          (f) => f.includes(`╭─ ${title} ─`) && !f.includes('loading'),
        )
        for (const line of frame.split('\n')) expect(cells(line)).toBeLessThanOrEqual(columns)
        const legend = legendOf(frame)
        expect(legend).not.toContain('…')
        expect(legend).toContain('[esc] back')
      }
      app.unmount()
    })

    test(`the add-person dialog at ${columns} columns`, async () => {
      const app = await open(columns)
      if (columns >= 100) {
        await pressUntil(app.stdin, app.lastFrame, DOWN, (f) => f.includes('▸ People'))
        await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('[enter] actions'))
      } else await pressUntil(app.stdin, app.lastFrame, '\t', (f) => f.includes('╭─ People ─'))
      await frameUntil(app.lastFrame, (f) => f.includes('suspended'))
      const frame = await pressUntil(app.stdin, app.lastFrame, 'n', (f) =>
        f.includes('Add a person'),
      )
      for (const line of frame.split('\n')) expect(cells(line)).toBeLessThanOrEqual(columns)
      expect(legendOf(frame)).not.toContain('…')
      expect(legendOf(frame)).toContain('[esc] cancel')
      app.unmount()
    })
  }
})
