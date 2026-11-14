import { afterEach, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { layoutOf } from './layout.ts'
import { chatReady, frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const history = (): UIMessage[] =>
  Array.from({ length: 40 }, (_, i) => ({
    id: `a${i}`,
    role: 'assistant',
    parts: [{ type: 'text', text: `answer ${i}` }],
  })) as UIMessage[]

describe('the bottom of the chat', () => {
  test.each([
    [100, 30],
    [120, 40],
    [190, 45],
    [80, 24],
    [60, 20],
  ])(
    'at %ix%i: rule, input, rule, legend, and nothing overlaps or runs wide',
    async (columns, rows) => {
      const { lastFrame, unmount } = await setupApp({ columns, rows, history: history() })
      await chatReady(lastFrame)
      await frameUntil(lastFrame, (f) => f.includes('answer 39'))
      const lines = (lastFrame() ?? '').split('\n')
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
      const rules = lines.map((l, i) => (/^─{20,}(\s|$)/.test(l) ? i : -1)).filter((i) => i >= 0)
      expect(rules).toHaveLength(2)
      const [top = -1, bottom = -1] = rules
      // the input is one row between the bare rules, the legend is the row under the bottom rule
      expect(bottom - top).toBe(2)
      expect(lines[top + 1]).toContain('type a message')
      expect(lines[top]?.split(/\s/)[0]).toMatch(/^─+$/)
      // both rules span the left column only: the sidebar beside it is not cut by them
      const left = layoutOf(columns, { rows }).left
      expect(lines[top]?.slice(0, left)).toBe('─'.repeat(left))
      expect(lines[bottom]?.slice(0, left)).toBe('─'.repeat(left))
      // a panel edge of the sidebar may sit on that row (`╰────╯`), a rule may not run on into it
      expect(lines[top]?.slice(left)).not.toMatch(/^\s*─/)
      expect(lines[bottom]?.slice(left).includes('─')).toBe(false)
      const legend = lines[bottom + 1] ?? ''
      expect(legend).toContain('[enter] send')
      expect(legend).toContain('/help')
      expect(legend).not.toContain('…')
      expect(legend).not.toMatch(/pgup|pgdn/)
      // the margin row (kept from 20 rows) is the last one; the legend is below the input
      expect(bottom + 1).toBe(rows >= 20 ? lines.length - 2 : lines.length - 1)
      // the messages stay above the top rule
      expect(lines.findIndex((l) => l.includes('answer 39'))).toBeLessThan(top)
      unmount()
    },
    30_000,
  )

  // the orb's rows in wide mode (the sidebar column is rows - 2 high: a blank row on top, the margin row at the bottom)
  const orbRows = (rows: number, columns: number): number =>
    Math.min(columns >= 160 ? 18 : 14, rows - 2 - 22)

  test.each([
    [100, 30],
    [120, 40],
    [190, 45],
  ])(
    'at %ix%i: the sidebar starts level with the KEITH line and runs past the prompt to the bottom',
    async (columns, rows) => {
      const { lastFrame, unmount } = await setupApp({ columns, rows, history: history() })
      await chatReady(lastFrame)
      await frameUntil(lastFrame, (f) => f.includes('Tasks'))
      const lines = (lastFrame() ?? '').split('\n')
      const keith = lines.findIndex((l) => l.includes('KEITH'))
      // narrow mode: the Tasks frame is the first one; wide mode: the wave graph frame (the orb is above it)
      const wide = rows >= 36
      const firstFrame = lines.findIndex(
        (l) => l.includes('╭') && (wide ? l.includes('idle') : l.includes('Tasks')),
      )
      expect(keith).toBeGreaterThanOrEqual(0)
      expect(firstFrame).toBe(wide ? keith + orbRows(rows, columns) : keith)
      const bottom = lines.findLastIndex((l) => /^─{20,}/.test(l))
      const lastSide = lines.map((l, i) => (/╯\s*$/.test(l) ? i : -1)).filter((i) => i >= 0)
      // the frames are not cut by the prompt: the sidebar column (its separator, checked below) runs
      // down to the margin row and the frames sit above it; spare height is empty space at the bottom
      expect(bottom).toBeGreaterThan(0)
      expect(Math.max(...lastSide)).toBeLessThan(lines.length - 1)
      expect(lines[lines.length - 2]?.includes('│')).toBe(true)
      for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
      unmount()
    },
    30_000,
  )

  test.each([
    [120, 40],
    [190, 45],
  ])(
    'at %ix%i: the orb is the first thing of the sidebar, level with the KEITH line',
    async (columns, rows) => {
      const { lastFrame, unmount } = await setupApp({ columns, rows })
      const f = await frameUntil(lastFrame, (x) => x.includes('Tasks'))
      const lines = f.split('\n')
      const keith = lines.findIndex((l) => l.includes('KEITH'))
      const orb = lines.findIndex((l) => l.includes('● idle'))
      // the orb (static dot and word without colour) is centred in its rows, in the sidebar column
      expect(orb).toBeGreaterThanOrEqual(keith)
      expect(orb).toBeLessThan(keith + orbRows(rows, columns))
      expect(lines[orb]?.indexOf('● idle')).toBeGreaterThan(columns - 42)
      // no orb in the header: the title row is alone on its row
      expect(lines[keith]).not.toContain('●')
      // the separator column runs the whole height of the sidebar
      const sep = lines[keith]?.indexOf('│') ?? -1
      expect(sep).toBeGreaterThan(0)
      for (let i = keith; i <= lines.length - 2; i++) expect(lines[i]?.[sep]).toBe('│')
      unmount()
    },
  )

  test.each([
    [120, 40],
    [190, 45],
  ])(
    'at %ix%i: the prompt row and the legend row stop at the separator, the sidebar column goes on beside them',
    async (columns, rows) => {
      const { lastFrame, unmount } = await setupApp({ columns, rows, history: history() })
      await chatReady(lastFrame)
      await frameUntil(lastFrame, (f) => f.includes('Tasks') && f.includes('type a message'))
      const lines = (lastFrame() ?? '').split('\n')
      const prompt = lines.findIndex((l) => l.includes('type a message'))
      const legend = prompt + 2
      const sep = layoutOf(columns, { rows }).left + 1
      for (const row of [prompt, legend]) {
        const line = lines[row] ?? ''
        // the left column ends before the separator, which runs through this row
        expect(Bun.stringWidth(line.slice(0, sep).trimEnd())).toBeLessThan(sep)
        expect(line[sep]).toBe('│')
      }
      expect(lines[legend]).toContain('[enter] send')
      expect(lines[legend]?.indexOf('/help')).toBeLessThan(sep)
      unmount()
    },
    30_000,
  )

  test('a newline in the draft grows the input between the rules', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ columns: 100, rows: 30 })
    await chatReady(lastFrame)
    stdin.write('a')
    await frameUntil(lastFrame, (f) => f.split('\n').some((l) => /^ {2}a\s/.test(l)))
    await pressUntil(stdin, lastFrame, '\u001b[13;2u', (f) => {
      const rows = f.split('\n')
      const rules = rows.map((l, i) => (/^─{20,}/.test(l) ? i : -1)).filter((i) => i >= 0)
      return rules.length === 2 && (rules[1] ?? 0) - (rules[0] ?? 0) === 3
    })
    unmount()
  })
})
