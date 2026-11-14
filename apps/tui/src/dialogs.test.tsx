import { afterEach, describe, expect, test } from 'bun:test'
import { approval } from './testing/fixtures.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const count = (frame: string, text: string): number => frame.split(text).length - 1

describe('a dialog that has the keys lists them once (tui-design 5.7)', () => {
  test.each([
    ['chat', 100, 30],
    ['chat', 60, 24],
    ['home', 100, 30],
    ['home', 80, 24],
  ] as const)('on the %s at %ix%i', async (start, columns, rows) => {
    const { lastFrame, stdin, unmount } = await setupApp({
      start,
      columns,
      rows,
      attention: [approval({ id: 'ap1' })],
    })
    await frameUntil(lastFrame, (f) => f.includes('tab to answer'))
    // unfocused: the page legend stays (it carries `tab approval`), the dialog only says `tab to answer`
    const before = lastFrame() ?? ''
    expect(count(before, '[y] allow')).toBe(0)
    await pressUntil(stdin, lastFrame, '\t', (f) => f.includes('[y] allow'))
    const f = lastFrame() ?? ''
    expect(count(f, '[y] allow')).toBe(1)
    expect(count(f, '[n] deny')).toBe(1)
    // the page's own keys are quiet meanwhile
    expect(f).not.toContain('[enter] send')
    expect(f).not.toContain('[space] menu')
    for (const row of f.split('\n')) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(columns)
    unmount()
  })

  test('the chat rule and the Home legend never contain …', async () => {
    for (const columns of [60, 80, 100, 120]) {
      for (const start of ['chat', 'home'] as const) {
        const { lastFrame, unmount } = await setupApp({ start, columns, rows: 30 })
        await frameUntil(lastFrame, (f) =>
          f.includes(start === 'chat' ? '[enter] send' : '[space]'),
        )
        const f = lastFrame() ?? ''
        const legend = f
          .split('\n')
          .find((l) => l.includes(start === 'chat' ? '[enter] send' : '[space]'))
        expect(legend).not.toContain('…')
        unmount()
        stopCores()
      }
    }
  })
})
