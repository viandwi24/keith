import { afterEach, describe, expect, test } from 'bun:test'
import { launch, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

const col = (line: string | undefined, needle: string): number => line?.indexOf(needle) ?? -1

describe.skipIf(!ptySupported)('the chat orb in a real pseudo-terminal (NO_COLOR)', () => {
  test(
    'at 120x40 the orb and the wave graph head the sidebar and a separator column runs beside it',
    async () => {
      const { cli } = await launch({}, [], 120, undefined, ['chat'], 40)
      await until(
        () => cli.screen().includes('╭─ idle'),
        20_000,
        'the wave graph frame',
        cli.screen,
      )
      const lines = cli.screen().split('\n')
      const title = lines.findIndex((l) => l.includes('KEITH'))
      const orb = lines.findIndex((l) => l.includes('● idle'))
      const graph = lines.findIndex((l) => l.includes('╭─ idle'))
      const brain = lines.findIndex((l) => l.includes('╭─ Brain'))
      // 120 columns: sidebar 32 wide, right margin 2, so it starts at column 86
      expect(col(lines[orb], '● idle')).toBeGreaterThanOrEqual(86)
      expect(col(lines[graph], '╭─ idle')).toBe(86)
      expect(orb).toBeGreaterThanOrEqual(title)
      expect(orb).toBeLessThan(graph)
      expect(brain).toBeGreaterThan(graph)
      // the title row has no orb; the separator is one column, at the same place on every row of the sidebar
      expect(lines[title]).not.toContain('●')
      const sep = col(lines[title], '│')
      expect(sep).toBe(84)
      // it runs the full height, past the prompt and the legend, down to the margin row
      const rule = lines.findIndex((l) => l.startsWith('────'))
      expect(rule).toBeGreaterThan(title)
      for (let i = title; i < lines.length - 1; i++) expect(lines[i]?.[sep]).toBe('│')
      // the prompt's rule stops at the separator
      expect(lines[rule]?.slice(0, sep).includes('─')).toBe(true)
      // a sidebar panel edge (`╰────╯`) may sit on that row; the rule itself does not run on into it
      expect(lines[rule]?.slice(sep + 1)).not.toMatch(/^\s*─/)
    },
    TEST_TIMEOUT,
  )

  test(
    'at 90x30 there is no sidebar: the orb is in the header, on the left, and no separator',
    async () => {
      const { cli } = await launch({}, [], 90, undefined, ['chat'], 30)
      await until(() => cli.screen().includes('● idle'), 20_000, 'the orb word', cli.screen)
      const lines = cli.screen().split('\n')
      const orb = lines.find((l) => l.includes('● idle'))
      expect(col(orb, '● idle')).toBeLessThan(20)
      expect(lines.some((l) => l.includes('│'))).toBe(false)
    },
    TEST_TIMEOUT,
  )
})
