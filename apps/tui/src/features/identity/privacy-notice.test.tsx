import { afterEach, describe, expect, test } from 'bun:test'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const TEXT =
  'The owner of this Keith can read what you keep in it. Each time they look, Keith writes it down: see Manage > Privacy.'
const TITLE = 'Your privacy'

/** A core that remembers the ack the way the real one does: once seen, always seen. */
function noticeRpc(seen = false) {
  let isSeen = seen
  let acks = 0
  return {
    rpc: {
      'admin/audit/notice/get': () => ({ notice: 'audit-privacy', text: TEXT, seen: isSeen }),
      'admin/audit/notice/ack': () => {
        acks++
        isSeen = true
        return { ok: true }
      },
    },
    acks: () => acks,
  }
}

/**
 * The notice panel as the terminal drew it: its width (border to border) and its body rows, each cut
 * at the panel's own sides. A row that does not sit between the sides is not part of the panel.
 */
function panelOf(frame: string): { width: number; body: string[] } {
  const lines = frame.split('\n')
  const top = lines.find((l) => l.includes('╭') && l.includes(TITLE)) ?? ''
  const col = [...top].indexOf('╭')
  if (col < 0) return { width: 0, body: [] }
  const width = [...top].indexOf('╮', col) - col + 1
  const start = lines.indexOf(top)
  const end = lines.findIndex((l, i) => i > start && [...l].at(col) === '╰')
  const body = lines.slice(start + 1, end).map((l) => [...l].slice(col, col + width))
  return {
    width,
    body: body.map((r) => r.slice(1, -1).join('').trim()).filter((r) => r !== ''),
  }
}

describe('the first-login notice is a panel over Home', () => {
  test('Home stays drawn while it shows; enter dismisses it and acks once', async () => {
    const n = noticeRpc()
    const app = await setupApp({ start: 'home', columns: 120, rows: 40, rpc: n.rpc })
    const f = await frameUntil(app.lastFrame, (x) => x.includes(TITLE))
    // the Home wordmark and the orb stay; the app is not replaced
    expect(f).toContain('K E I T H')
    expect(f).toContain(TITLE)
    expect(f).toContain('got it')
    expect(f).not.toContain('[space] menu')
    const panel = panelOf(f)
    // at most 46 cells, the text wrapped inside it (more than one body row)
    expect(panel.width).toBeLessThanOrEqual(46)
    expect(panel.body.length).toBeGreaterThan(1)
    expect(panel.body.join(' ')).toContain('The owner of this Keith can read what you keep in it.')
    await pressUntil(app.stdin, app.lastFrame, '\r', (x) => !x.includes(TITLE))
    expect(app.lastFrame()).toContain('K E I T H')
    expect(app.lastFrame()).toContain('[space] menu')
    await Bun.sleep(100)
    expect(n.acks()).toBe(1)
    app.unmount()
  })

  test('a seen notice never shows; a core that cannot answer never blocks Home', async () => {
    const seen = noticeRpc(true)
    const a = await setupApp({ start: 'home', rpc: seen.rpc })
    await Bun.sleep(150)
    expect(a.lastFrame()).toContain('K E I T H')
    expect(a.lastFrame()).not.toContain(TITLE)
    expect(seen.acks()).toBe(0)
    a.unmount()
    // no notice route at all (an older core): Home, no panel
    const b = await setupApp({ start: 'home' })
    await Bun.sleep(150)
    expect(b.lastFrame()).toContain('[space] menu')
    expect(b.lastFrame()).not.toContain(TITLE)
    b.unmount()
  })

  test.each([80, 120])(
    'at %i columns the panel is compact and Home is still drawn',
    async (columns) => {
      const n = noticeRpc()
      const app = await setupApp({ start: 'home', columns, rows: 30, rpc: n.rpc })
      const f = await frameUntil(app.lastFrame, (x) => x.includes(TITLE))
      expect(f).toContain('K E I T H')
      const panel = panelOf(f)
      expect(panel.width).toBeLessThanOrEqual(46)
      expect(panel.body.length).toBeGreaterThan(1)
      app.unmount()
    },
  )
})
